import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import type { BookingModule, RefundCause } from '../../booking/index.ts';
import {
  nextPaymentStatus,
  PAYMENT_EXPIRY_MINUTES,
  type PaymentSignal,
  type PaymentStatus,
  type RefundReason,
} from '../domain/payment.ts';
import type { PaymentProvider, ProviderEvent, ProviderPayment, ProviderRefund } from '../domain/provider.ts';
import '../domain/events.ts';
import type { PaymentsDb, PaymentsTable } from '../infrastructure/tables.ts';

type PaymentRow = Selectable<PaymentsTable>;
type Source = 'CUSTOMER' | 'WEBHOOK' | 'PROVIDER_QUERY' | 'SYSTEM';
const MAX_REFUND_ATTEMPTS = 5;

export const paymentErrors = {
  notPayable: (status: string) =>
    new DomainError({
      code: 'payment.booking_not_payable',
      status: 409,
      title: 'This booking can’t be paid now',
      detail:
        status === 'EXPIRED'
          ? 'The hold lapsed. Book again to get a new price.'
          : `The booking is ${status.toLowerCase().replaceAll('_', ' ')}.`,
    }),
  invalidSignature: () =>
    new DomainError({ code: 'payment.invalid_signature', status: 401, title: 'Invalid webhook signature' }),
  idempotencyRequired: () =>
    new DomainError({
      code: 'payment.idempotency_key_required',
      status: 400,
      title: 'Idempotency-Key header required',
      detail: 'Send a unique key (8–100 letters, digits, - or _) per payment attempt.',
    }),
};

const CAUSE_TO_REASON: Record<RefundCause, RefundReason> = {
  CUSTOMER_CANCELLED: 'CUSTOMER_CANCELLED',
  HOST_CANCELLED: 'HOST_CANCELLED',
  PLATFORM_CANCELLED: 'PLATFORM_CANCELLED',
  SERIES_ENDED: 'SERIES_ENDED',
};

/**
 * Payments (Phase 15; domain-model §5.5, BR-15; CLAUDE.md §15). Rules:
 * - SUCCEEDED only from a signature-verified webhook or a server-side query of the provider. The browser's return
 *   from checkout only triggers that query.
 * - A success confirms the booking through the booking module; if the booking can no longer be confirmed (late
 *   success, unit gone) or was already paid, the payment is refunded in full automatically.
 * - The amount must match the order we created; otherwise the payment is quarantined for finance, never confirmed.
 * - Every handler is idempotent; webhooks are deduplicated by provider event id.
 */
export function createPaymentService(deps: {
  db: Kysely<PaymentsDb>;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'paymentContext' | 'confirmPayment'>;
  provider: PaymentProvider;
  now?: () => number;
}) {
  const { db, audit, provider } = deps;
  const now = deps.now ?? Date.now;

  // ---------------------------------------------------------------- state changes

  async function move(
    trx: Transaction<PaymentsDb>,
    row: PaymentRow,
    signal: PaymentSignal,
    source: Source,
    requestId: string,
    set: Partial<{
      provider_payment_id: string;
      method: string | null;
      failure_code: string | null;
      failure_reason: string | null;
    }> = {},
    detail?: string,
  ): Promise<PaymentStatus | null> {
    const to = nextPaymentStatus(row.status as PaymentStatus, signal);
    if (!to) return null;
    await trx
      .updateTable('payments.payments')
      .set({
        status: to,
        version: sql<number>`version + 1`,
        ...(to === 'SUCCEEDED'
          ? { succeeded_at: new Date(now()), failure_code: null, failure_reason: null }
          : {}),
        ...set,
      })
      .where('id', '=', row.id)
      .execute();
    await trx
      .insertInto('payments.payment_events')
      .values({
        payment_id: row.id,
        from_status: row.status,
        to_status: to,
        source,
        detail: detail ?? signal,
        request_id: requestId,
      })
      .execute();
    return to;
  }

  async function reconciliation(
    executor: AnyKyselyExecutor,
    kind: string,
    dedupeKey: string,
    refs: Record<string, unknown>,
  ) {
    await (executor as unknown as Kysely<PaymentsDb>)
      .insertInto('payments.reconciliation_items')
      .values({ id: uuidv7(), kind, dedupe_key: dedupeKey, refs: JSON.stringify(refs) })
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .execute();
  }

  /** Records a refund to be executed by the refund job (idempotent per key; capped by the captured amount). */
  async function recordRefund(
    executor: AnyKyselyExecutor,
    input: { paymentId: string; bookingId: string; amountPaise: number; reason: RefundReason; key: string },
  ) {
    const x = executor as unknown as Kysely<PaymentsDb>;
    await x
      .selectFrom('payments.payments')
      .select('id')
      .where('id', '=', input.paymentId)
      .forUpdate()
      .execute();
    const inserted = await x
      .insertInto('payments.refunds')
      .values({
        id: uuidv7(),
        payment_id: input.paymentId,
        booking_id: input.bookingId,
        amount_paise: input.amountPaise,
        reason: input.reason,
        status: 'PENDING',
        idempotency_key: input.key,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      await deps.events.publish(
        'payment.refund_recorded',
        {
          refundId: inserted.id,
          paymentId: input.paymentId,
          bookingId: input.bookingId,
          amountPaise: input.amountPaise,
          requestId: input.key,
        },
        executor,
      );
    }
  }

  // Booking cancellations with a refund amount (Phase 12 policy) become refunds here, in the same transaction.
  deps.events.subscribe('booking.refund_due', async (e, executor) => {
    const x = executor as unknown as Kysely<PaymentsDb>;
    const paid = await x
      .selectFrom('payments.payments')
      .select(['id', 'amount_paise'])
      .where('booking_id', '=', e.bookingId)
      .where('status', '=', 'SUCCEEDED')
      .orderBy('succeeded_at')
      .executeTakeFirst();
    if (!paid) return; // nothing was collected through payments (e.g. a booking confirmed before Phase 15)
    await recordRefund(executor, {
      paymentId: paid.id,
      bookingId: e.bookingId,
      amountPaise: Math.min(e.amountPaise, Number(paid.amount_paise)),
      reason: CAUSE_TO_REASON[e.cause],
      key: `booking:${e.bookingId}:cancel`,
    });
  });

  /**
   * The single success path. Marks the payment SUCCEEDED, then asks the booking module to confirm. Already-paid
   * bookings and bookings that can't be confirmed any more get a full refund (BR-15).
   */
  async function succeed(paymentId: string, p: ProviderPayment, source: Source, requestId: string) {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('payments.payments')
        .selectAll()
        .where('id', '=', paymentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.status === 'SUCCEEDED') return 'ALREADY' as const;
      if (row.mismatch) return 'QUARANTINED' as const;
      if (
        p.amountPaise !== Number(row.amount_paise) ||
        p.currency !== 'INR' ||
        p.orderId !== row.provider_order_id
      ) {
        await trx
          .updateTable('payments.payments')
          .set({ mismatch: true, provider_payment_id: p.paymentId })
          .where('id', '=', row.id)
          .execute();
        await trx
          .insertInto('payments.payment_events')
          .values({
            payment_id: row.id,
            from_status: row.status,
            to_status: row.status,
            source,
            detail: `amount mismatch: got ${p.amountPaise} ${p.currency}`,
            request_id: requestId,
          })
          .execute();
        await reconciliation(trx, 'AMOUNT_MISMATCH', `mismatch:${row.id}`, {
          paymentId: row.id,
          bookingId: row.booking_id,
          expected: Number(row.amount_paise),
          received: p.amountPaise,
          providerPaymentId: p.paymentId,
        });
        return 'QUARANTINED' as const;
      }
      const other = await trx
        .selectFrom('payments.payments')
        .select('id')
        .where('booking_id', '=', row.booking_id)
        .where('status', '=', 'SUCCEEDED')
        .where('id', '<>', row.id)
        .executeTakeFirst();
      await move(
        trx,
        row,
        'CAPTURED',
        source,
        requestId,
        { provider_payment_id: p.paymentId, method: p.method },
        'captured',
      );
      // The ledger posts the capture in this same transaction (Phase 16).
      await deps.events.publish(
        'payment.captured',
        { paymentId: row.id, bookingId: row.booking_id, amountPaise: Number(row.amount_paise), requestId },
        trx,
      );
      if (other) {
        await recordRefund(trx, {
          paymentId: row.id,
          bookingId: row.booking_id,
          amountPaise: Number(row.amount_paise),
          reason: 'DUPLICATE_PAYMENT',
          key: `payment:${row.id}:duplicate`,
        });
        return 'DUPLICATE' as const;
      }
      return 'CONFIRM' as const;
    });
    if (outcome === 'CONFIRM') await confirmOrRefund(paymentId, requestId);
    return outcome;
  }

  /** Booking confirmation for a succeeded payment; idempotent, also used by reconciliation to repair a crash. */
  async function confirmOrRefund(paymentId: string, requestId: string) {
    const row = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    const { confirmed } = await deps.booking.confirmPayment(row.booking_id, requestId);
    if (!confirmed) {
      await db.transaction().execute((trx) =>
        recordRefund(trx, {
          paymentId,
          bookingId: row.booking_id,
          amountPaise: Number(row.amount_paise),
          reason: 'LATE_PAYMENT_UNAVAILABLE',
          key: `payment:${paymentId}:late`,
        }),
      );
    }
    await audit.record({
      actorKind: 'SYSTEM',
      actorId: null,
      action: confirmed ? 'payment.booking_confirmed' : 'payment.refunded_unconfirmable',
      entityKind: 'payment',
      entityId: paymentId,
      metadata: { bookingId: row.booking_id },
      requestId,
    });
  }

  /** Applies what the provider reports about one attempt (webhook or query). */
  async function applyProviderPayment(
    row: PaymentRow,
    p: ProviderPayment,
    source: Source,
    requestId: string,
  ) {
    let attempt = p;
    if (attempt.status === 'authorized') {
      // Auto-capture should be on; capture ourselves if it isn't, for the amount we created (never more).
      attempt = await provider.capture(attempt.paymentId, Number(row.amount_paise));
    }
    if (attempt.status === 'captured' || attempt.status === 'refunded')
      return succeed(row.id, attempt, source, requestId);
    if (attempt.status === 'failed') {
      await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('payments.payments')
          .selectAll()
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const moved = await move(
          trx,
          locked,
          'FAILED',
          source,
          requestId,
          {
            failure_code: attempt.errorCode,
            failure_reason: attempt.errorDescription?.slice(0, 300) ?? null,
          },
          'failed',
        );
        if (moved)
          await deps.events.publish(
            'payment.failed',
            { paymentId: row.id, bookingId: row.booking_id, requestId },
            trx,
          );
      });
      return 'FAILED' as const;
    }
    return 'NO_CHANGE' as const;
  }

  // ---------------------------------------------------------------- customer

  async function createPayment(
    customerId: string,
    bookingId: string,
    idempotencyKey: string,
    requestId: string,
  ) {
    const existing = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return view(existing);

    const ctx = await deps.booking.paymentContext(bookingId);
    if (!ctx || ctx.customerId !== customerId) throw errors.notFound();
    if (ctx.status !== 'PENDING_PAYMENT') throw paymentErrors.notPayable(ctx.status);
    // A second tap (new key) while an attempt is open reuses it: one provider order per attempt window.
    const open = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .where('status', 'in', ['CREATED', 'PENDING'])
      .where('amount_paise', '=', String(ctx.totalPaise) as never)
      .where(sql<boolean>`created_at > now() - make_interval(mins => ${PAYMENT_EXPIRY_MINUTES})`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (open) return view(open);

    await deps.rateLimiter.enforce({
      key: `payment-create:customer1h:${customerId}`,
      limit: 15,
      windowSeconds: 3600,
    });
    const id = uuidv7();
    // Provider call outside any DB transaction; the order is harmless until a payment against it is verified.
    const order = await provider.createOrder({
      amountPaise: ctx.totalPaise,
      receipt: id,
      notes: { bookingId, paymentId: id },
    });
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('payments.payments')
          .values({
            id,
            booking_id: bookingId,
            customer_id: customerId,
            provider: provider.name,
            provider_order_id: order.orderId,
            amount_paise: ctx.totalPaise,
            status: 'CREATED',
            idempotency_key: idempotencyKey,
          })
          .execute();
        await trx
          .insertInto('payments.payment_events')
          .values({
            payment_id: id,
            from_status: null,
            to_status: 'CREATED',
            source: 'CUSTOMER',
            detail: 'order created',
            request_id: requestId,
          })
          .execute();
      });
    } catch (error) {
      // Same key raced in parallel: return the winner.
      if ((error as { constraint?: string }).constraint === 'payments_customer_id_idempotency_key_key') {
        const winner = await db
          .selectFrom('payments.payments')
          .selectAll()
          .where('customer_id', '=', customerId)
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirstOrThrow();
        return view(winner);
      }
      throw error;
    }
    return view(
      await db.selectFrom('payments.payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    );
  }

  /**
   * The browser came back from checkout. Its claims are never trusted: we only use them to ask the provider (server
   * to server) what really happened to the order.
   */
  async function clientReturned(
    customerId: string,
    paymentId: string,
    input: { providerPaymentId?: string | undefined; signature?: string | undefined },
    requestId: string,
  ) {
    const row = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('id', '=', paymentId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const signatureOk =
      input.providerPaymentId && input.signature
        ? provider.verifyCheckoutSignature({
            orderId: row.provider_order_id,
            paymentId: input.providerPaymentId,
            signature: input.signature,
          })
        : null;
    await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('payments.payments')
        .selectAll()
        .where('id', '=', paymentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await move(
        trx,
        locked,
        'CLIENT_RETURNED',
        'CUSTOMER',
        requestId,
        {},
        `client returned (signature ${signatureOk === null ? 'absent' : signatureOk ? 'valid' : 'INVALID'})`,
      );
    });
    await syncFromProvider(paymentId, requestId);
    return view(
      await db
        .selectFrom('payments.payments')
        .selectAll()
        .where('id', '=', paymentId)
        .executeTakeFirstOrThrow(),
    );
  }

  /** Server-side status query (also used by reconciliation). */
  async function syncFromProvider(paymentId: string, requestId: string) {
    const row = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    if (row.status === 'SUCCEEDED') return;
    const attempts = await provider.fetchOrderPayments(row.provider_order_id);
    const captured = attempts.find(
      (a) => a.status === 'captured' || a.status === 'authorized' || a.status === 'refunded',
    );
    if (captured) {
      await applyProviderPayment(row, captured, 'PROVIDER_QUERY', requestId);
      return;
    }
    const failed = attempts.filter((a) => a.status === 'failed').at(-1);
    if (failed) await applyProviderPayment(row, failed, 'PROVIDER_QUERY', requestId);
  }

  // ---------------------------------------------------------------- webhooks

  async function handleWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    requestId: string,
  ) {
    if (!provider.verifyWebhook(rawBody, headers)) throw paymentErrors.invalidSignature();
    let event: ProviderEvent;
    try {
      event = provider.parseWebhook(rawBody, headers);
    } catch {
      throw new DomainError({
        code: 'payment.malformed_webhook',
        status: 400,
        title: 'Malformed webhook body',
      });
    }
    await db
      .insertInto('payments.provider_events')
      .values({
        provider: provider.name,
        event_id: event.eventId,
        event_type: event.type === 'ignored' ? event.name : event.type,
        payload: rawBody,
      })
      .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
      .execute();
    // Claim the event (a 2-minute lease): a concurrent or repeated delivery of a processed or in-flight event is a
    // duplicate. A delivery whose processing crashed is reclaimed after the lease.
    const claimed = await db
      .updateTable('payments.provider_events')
      .set({ claimed_at: new Date(now()) })
      .where('provider', '=', provider.name)
      .where('event_id', '=', event.eventId)
      .where('processed_at', 'is', null)
      .where('quarantined_reason', 'is', null)
      .where((eb) =>
        eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', sql<Date>`now() - interval '2 minutes'`)]),
      )
      .returning('id')
      .executeTakeFirst();
    if (!claimed) return { status: 'duplicate' as const };
    const mark = (set: { processed_at?: Date; quarantined_reason?: string }) =>
      db
        .updateTable('payments.provider_events')
        .set(set)
        .where('provider', '=', provider.name)
        .where('event_id', '=', event.eventId)
        .execute();

    if (event.type === 'ignored') {
      await mark({ processed_at: new Date(now()) });
      return { status: 'ignored' as const };
    }
    if (event.type === 'payment') {
      const row = await db
        .selectFrom('payments.payments')
        .selectAll()
        .where('provider', '=', provider.name)
        .where('provider_order_id', '=', event.payment.orderId)
        .executeTakeFirst();
      if (!row) {
        await reconciliation(db, 'UNKNOWN_PAYMENT', `unknown:${event.payment.paymentId}`, {
          providerPaymentId: event.payment.paymentId,
          orderId: event.payment.orderId,
          amountPaise: event.payment.amountPaise,
        });
        await mark({ quarantined_reason: 'unknown order' });
        return { status: 'quarantined' as const };
      }
      const result = await applyProviderPayment(row, event.payment, 'WEBHOOK', requestId);
      await mark(
        result === 'QUARANTINED'
          ? { quarantined_reason: 'amount mismatch' }
          : { processed_at: new Date(now()) },
      );
      return { status: result === 'QUARANTINED' ? ('quarantined' as const) : ('processed' as const) };
    }
    await applyProviderRefund(event.refund, requestId);
    await mark({ processed_at: new Date(now()) });
    return { status: 'processed' as const };
  }

  /** Marks a refund succeeded once and tells the customer (notifications). */
  async function refundSucceeded(refundId: string) {
    await db.transaction().execute(async (trx) => {
      const done = await trx
        .updateTable('payments.refunds')
        .set({ status: 'SUCCEEDED' })
        .where('id', '=', refundId)
        .where('status', 'in', ['PENDING', 'SUBMITTED'])
        .returning(['id', 'booking_id', 'amount_paise'])
        .executeTakeFirst();
      if (done) {
        await deps.events.publish(
          'payment.refund_succeeded',
          { refundId: done.id, bookingId: done.booking_id, amountPaise: Number(done.amount_paise) },
          trx,
        );
      }
    });
  }

  async function applyProviderRefund(r: ProviderRefund, requestId: string) {
    const refund = await db
      .selectFrom('payments.refunds')
      .selectAll()
      .where('provider_refund_id', '=', r.refundId)
      .executeTakeFirst();
    if (!refund || refund.status === 'SUCCEEDED' || refund.status === 'FAILED') return;
    if (r.status === 'processed') {
      await refundSucceeded(refund.id);
    } else if (r.status === 'failed') {
      await db
        .updateTable('payments.refunds')
        .set({ status: 'FAILED', failure_reason: 'provider reported failure' })
        .where('id', '=', refund.id)
        .execute();
      await reconciliation(db, 'REFUND_FAILED', `refund-failed:${refund.id}`, {
        refundId: refund.id,
        paymentId: refund.payment_id,
        requestId,
      });
    }
  }

  // ---------------------------------------------------------------- jobs

  /** Submits PENDING refunds to the provider; retries with a cap, then hands over to finance. */
  async function submitRefunds(): Promise<number> {
    const pending = await db
      .selectFrom('payments.refunds as r')
      .innerJoin('payments.payments as p', 'p.id', 'r.payment_id')
      .select(['r.id', 'r.amount_paise', 'r.attempts', 'p.provider_payment_id'])
      .where('r.status', '=', 'PENDING')
      .orderBy('r.created_at')
      .limit(100)
      .execute();
    let submitted = 0;
    for (const r of pending) {
      try {
        const result = await provider.refund({
          paymentId: r.provider_payment_id ?? '',
          amountPaise: Number(r.amount_paise),
          receipt: r.id,
        });
        await db
          .updateTable('payments.refunds')
          .set({
            status: result.status === 'failed' ? 'FAILED' : 'SUBMITTED',
            provider_refund_id: result.refundId,
            attempts: sql<number>`attempts + 1`,
          })
          .where('id', '=', r.id)
          .where('status', '=', 'PENDING')
          .execute();
        if (result.status === 'processed') await refundSucceeded(r.id);
        submitted += 1;
      } catch (error) {
        const attempts = r.attempts + 1;
        await db
          .updateTable('payments.refunds')
          .set({
            attempts,
            ...(attempts >= MAX_REFUND_ATTEMPTS
              ? { status: 'FAILED', failure_reason: String((error as Error).message).slice(0, 300) }
              : {}),
          })
          .where('id', '=', r.id)
          .execute();
        if (attempts >= MAX_REFUND_ATTEMPTS)
          await reconciliation(db, 'REFUND_FAILED', `refund-failed:${r.id}`, { refundId: r.id });
      }
    }
    return submitted;
  }

  /**
   * Reconciliation (missed webhooks, crashes between payment success and booking confirmation, expiry, refund status).
   */
  async function reconcile(): Promise<number> {
    let changed = 0;
    const open = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('status', 'in', ['CREATED', 'PENDING', 'FAILED'])
      .where(sql<boolean>`created_at < now() - interval '2 minutes'`)
      .where(sql<boolean>`created_at > now() - interval '7 days'`)
      .orderBy('created_at')
      .limit(200)
      .execute();
    for (const row of open) {
      const before = row.status;
      try {
        await syncFromProvider(row.id, 'job:payments-reconcile');
      } catch {
        continue; // provider unreachable: next tick
      }
      const after = await db
        .selectFrom('payments.payments')
        .select('status')
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      if (after.status !== before) changed += 1;
      if (
        ['CREATED', 'PENDING'].includes(after.status) &&
        row.created_at.getTime() < now() - PAYMENT_EXPIRY_MINUTES * 60_000
      ) {
        await db.transaction().execute(async (trx) => {
          const locked = await trx
            .selectFrom('payments.payments')
            .selectAll()
            .where('id', '=', row.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (
            await move(
              trx,
              locked,
              'EXPIRED',
              'SYSTEM',
              'job:payments-reconcile',
              {},
              'no payment within the window',
            )
          )
            changed += 1;
        });
      }
    }

    // Succeeded but not reflected on the booking and not refunded (crash between the two steps): repair.
    const stuck = await db
      .selectFrom('payments.payments as p')
      .leftJoin('payments.refunds as r', 'r.payment_id', 'p.id')
      .select(['p.id', 'p.booking_id'])
      .where('p.status', '=', 'SUCCEEDED')
      .where('r.id', 'is', null)
      .where(sql<boolean>`p.succeeded_at > now() - interval '7 days'`)
      .limit(200)
      .execute();
    for (const p of stuck) {
      const ctx = await deps.booking.paymentContext(p.booking_id);
      if (ctx && ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW'].includes(ctx.status)) continue;
      if (ctx && ctx.status === 'CANCELLED') continue; // the cancellation's own refund covers it
      await confirmOrRefund(p.id, 'job:payments-reconcile');
      await reconciliation(db, 'STUCK_CONFIRMATION', `stuck:${p.id}`, {
        paymentId: p.id,
        bookingId: p.booking_id,
      });
      changed += 1;
    }

    // Submitted refunds: ask the provider.
    const submitted = await db
      .selectFrom('payments.refunds as r')
      .innerJoin('payments.payments as p', 'p.id', 'r.payment_id')
      .select(['r.provider_refund_id', 'p.provider_payment_id'])
      .where('r.status', '=', 'SUBMITTED')
      .limit(200)
      .execute();
    for (const r of submitted) {
      try {
        await applyProviderRefund(
          await provider.fetchRefund(r.provider_payment_id ?? '', r.provider_refund_id ?? ''),
          'job:payments-reconcile',
        );
      } catch {
        // next tick
      }
    }
    return changed;
  }

  /** Daily settlement import and matching (database-design §8). `day` is a UTC date. */
  async function importSettlements(
    day = new Date(now() - 86_400_000).toISOString().slice(0, 10),
  ): Promise<number> {
    const lines = await provider.fetchSettlements(day);
    for (const l of lines) {
      await db
        .insertInto('payments.settlement_lines')
        .values({
          provider: provider.name,
          settlement_id: l.settlementId,
          entity_kind: l.entityKind,
          provider_entity_id: l.entityId,
          amount_paise: l.amountPaise,
          fee_paise: l.feePaise,
          tax_paise: l.taxPaise,
          settled_at: l.settledAt,
        })
        .onConflict((oc) => oc.columns(['provider', 'settlement_id', 'provider_entity_id']).doNothing())
        .execute();
      if (l.entityKind !== 'PAYMENT') continue;
      const p = await db
        .selectFrom('payments.payments')
        .select(['id', 'amount_paise', 'status'])
        .where('provider', '=', provider.name)
        .where('provider_payment_id', '=', l.entityId)
        .executeTakeFirst();
      if (!p)
        await reconciliation(db, 'UNKNOWN_PAYMENT', `settled-unknown:${l.entityId}`, {
          providerPaymentId: l.entityId,
          settlementId: l.settlementId,
          amountPaise: l.amountPaise,
        });
      else if (Number(p.amount_paise) !== l.amountPaise || p.status !== 'SUCCEEDED')
        await reconciliation(db, 'SETTLEMENT_MISMATCH', `settled-mismatch:${p.id}`, {
          paymentId: p.id,
          settled: l.amountPaise,
          expected: Number(p.amount_paise),
          status: p.status,
        });
    }
    return lines.length;
  }

  // ---------------------------------------------------------------- reads

  function view(row: PaymentRow) {
    return {
      id: row.id,
      bookingId: row.booking_id,
      status: row.status as PaymentStatus,
      provider: row.provider as 'FAKE' | 'RAZORPAY',
      amountPaise: Number(row.amount_paise),
      currency: 'INR' as const,
      method: row.method,
      failureReason: row.status === 'FAILED' ? row.failure_reason : null,
      // Public checkout values only (key id, order id, amount); never secrets.
      checkout: ['CREATED', 'PENDING', 'FAILED'].includes(row.status)
        ? provider.checkoutParams({ orderId: row.provider_order_id, amountPaise: Number(row.amount_paise) })
        : null,
      createdAt: row.created_at,
      succeededAt: row.succeeded_at,
    };
  }

  async function bookingPayments(customerId: string, bookingId: string) {
    const ctx = await deps.booking.paymentContext(bookingId);
    if (!ctx || ctx.customerId !== customerId) throw errors.notFound();
    const rows = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('created_at')
      .execute();
    const refunds = await db
      .selectFrom('payments.refunds')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('created_at')
      .execute();
    return {
      payments: rows.map(view),
      refunds: refunds.map((r) => ({
        id: r.id,
        amountPaise: Number(r.amount_paise),
        reason: r.reason as RefundReason,
        status: r.status as 'PENDING' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED',
        createdAt: r.created_at,
      })),
    };
  }

  async function getPayment(customerId: string, paymentId: string) {
    const row = await db
      .selectFrom('payments.payments')
      .selectAll()
      .where('id', '=', paymentId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    return view(row);
  }

  /** Admin lists (Phase 20, A-05). */
  async function adminPayments(f: {
    status?: string | undefined;
    bookingId?: string | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('payments.payments');
    if (f.status) q = q.where('status', '=', f.status);
    if (f.bookingId) q = q.where('booking_id', '=', f.bookingId);
    const [rows, total] = await Promise.all([
      q.selectAll().orderBy('created_at', 'desc').offset(f.offset).limit(f.limit).execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id,
        bookingId: p.booking_id,
        provider: p.provider,
        status: p.status,
        amountPaise: Number(p.amount_paise),
        method: p.method,
        mismatch: p.mismatch,
        createdAt: p.created_at,
        succeededAt: p.succeeded_at,
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  async function adminRefunds(f: { status?: string | undefined; offset: number; limit: number }) {
    let q = db.selectFrom('payments.refunds');
    if (f.status) q = q.where('status', '=', f.status);
    const [rows, total] = await Promise.all([
      q.selectAll().orderBy('created_at', 'desc').offset(f.offset).limit(f.limit).execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        bookingId: r.booking_id,
        paymentId: r.payment_id,
        amountPaise: Number(r.amount_paise),
        reason: r.reason,
        status: r.status,
        attempts: r.attempts,
        createdAt: r.created_at,
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  async function riskSignals() {
    const rows = await db
      .selectFrom('payments.reconciliation_items')
      .select(['kind', sql<string>`count(*)`.as('n')])
      .where('status', '=', 'OPEN')
      .groupBy('kind')
      .execute();
    return rows.map((r) => ({
      kind: `RECONCILIATION_${r.kind}`,
      subject: { kind: 'finance', id: r.kind },
      count: Number(r.n),
      detail: `${r.n} open ${r.kind.toLowerCase().replaceAll('_', ' ')} item(s)`,
    }));
  }

  /** Money of one booking for admins (dispute evidence): attempts and refunds, no secrets. */
  async function adminBookingMoney(bookingId: string) {
    const [rows, refunds] = await Promise.all([
      db
        .selectFrom('payments.payments')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('payments.refunds')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .orderBy('created_at')
        .execute(),
    ]);
    return {
      payments: rows.map((p) => ({
        id: p.id,
        status: p.status,
        amountPaise: Number(p.amount_paise),
        method: p.method,
        mismatch: p.mismatch,
        createdAt: p.created_at,
        succeededAt: p.succeeded_at,
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        amountPaise: Number(r.amount_paise),
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * A refund decided by an admin in a dispute (Phase 19). Capped by what is still refundable (captured − refunded);
   * goes through the normal pipeline (ledger journal, provider submission, customer notification).
   */
  async function refundForDispute(input: { bookingId: string; disputeId: string; amountPaise: number }) {
    return db.transaction().execute(async (trx) => {
      const paid = await trx
        .selectFrom('payments.payments')
        .select(['id', 'amount_paise'])
        .where('booking_id', '=', input.bookingId)
        .where('status', '=', 'SUCCEEDED')
        .orderBy('succeeded_at')
        .forUpdate()
        .executeTakeFirst();
      if (!paid) return { refundedPaise: 0 };
      const done = await trx
        .selectFrom('payments.refunds')
        .select(sql<string>`coalesce(sum(amount_paise), 0)`.as('s'))
        .where('payment_id', '=', paid.id)
        .where('status', '<>', 'FAILED')
        .executeTakeFirstOrThrow();
      const amount = Math.min(input.amountPaise, Number(paid.amount_paise) - Number(done.s));
      if (amount <= 0) return { refundedPaise: 0 };
      await recordRefund(trx, {
        paymentId: paid.id,
        bookingId: input.bookingId,
        amountPaise: amount,
        reason: 'DISPUTE',
        key: `dispute:${input.disputeId}`,
      });
      return { refundedPaise: amount };
    });
  }

  /** Recent captured payments and recorded refunds, for the ledger's backfill/repair job (Phase 16). */
  async function ledgerFeed() {
    const [captured, refunds] = await Promise.all([
      db
        .selectFrom('payments.payments')
        .select(['id', 'booking_id', 'amount_paise'])
        .where('status', '=', 'SUCCEEDED')
        .where(sql<boolean>`succeeded_at > now() - interval '30 days'`)
        .limit(1000)
        .execute(),
      db
        .selectFrom('payments.refunds')
        .select(['id', 'payment_id', 'booking_id', 'amount_paise'])
        .where('status', '<>', 'FAILED')
        .where(sql<boolean>`created_at > now() - interval '30 days'`)
        .limit(1000)
        .execute(),
    ]);
    return {
      captured: captured.map((p) => ({
        paymentId: p.id,
        bookingId: p.booking_id,
        amountPaise: Number(p.amount_paise),
      })),
      refunds: refunds.map((r) => ({
        refundId: r.id,
        paymentId: r.payment_id,
        bookingId: r.booking_id,
        amountPaise: Number(r.amount_paise),
      })),
    };
  }

  async function openReconciliation() {
    const rows = await db
      .selectFrom('payments.reconciliation_items')
      .selectAll()
      .where('status', '=', 'OPEN')
      .orderBy('created_at')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      refs: r.refs as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  async function resolveReconciliation(adminId: string, itemId: string, note: string, requestId: string) {
    const res = await db
      .updateTable('payments.reconciliation_items')
      .set({ status: 'RESOLVED', note, resolved_by: adminId, resolved_at: new Date(now()) })
      .where('id', '=', itemId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
    await audit.record({
      actorKind: 'ADMIN',
      actorId: adminId,
      action: 'payments.reconciliation_resolved',
      entityKind: 'reconciliation_item',
      entityId: itemId,
      metadata: { note },
      requestId,
    });
  }

  return {
    createPayment,
    clientReturned,
    handleWebhook,
    bookingPayments,
    getPayment,
    submitRefunds,
    reconcile,
    importSettlements,
    openReconciliation,
    resolveReconciliation,
    ledgerFeed,
    adminBookingMoney,
    refundForDispute,
    adminPayments,
    adminRefunds,
    riskSignals,
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
