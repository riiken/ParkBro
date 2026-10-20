import { sql, type Kysely } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { HostAccess, HostService } from '../../identity/index.ts';
import type { PaymentsModule } from '../../payments/index.ts';
import {
  captureSplit,
  MIN_PAYOUT_PAISE,
  PAYOUT_ACCOUNT_CHANGE_HOLD_HOURS,
  refundSplit,
  RELEASE_AFTER_END_HOURS,
  type Split,
} from '../domain/split.ts';
import '../domain/events.ts';
import type { EarningsDb } from '../infrastructure/tables.ts';
import { createLedger, type Line } from './ledger.ts';

const DETAILS_CONTEXT = 'payouts.payout_accounts.details';
const HOLDING = ['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'];
type Host = HostAccess & { userId: string };

export const earningsErrors = {
  ownerOnly: () =>
    new DomainError({
      code: 'payout.owner_only',
      status: 403,
      title: 'Only the account owner can change payout details',
    }),
  invalidDetails: (detail: string) =>
    new DomainError({
      code: 'payout.invalid_details',
      status: 400,
      title: 'Check your payout details',
      detail,
    }),
  transitionNotAllowed: (from: string) =>
    new DomainError({
      code: 'payout.transition_not_allowed',
      status: 409,
      title: 'That action is not available for this payout',
      detail: `The payout is ${from.toLowerCase()}.`,
    }),
};

/**
 * Host earnings and payouts (Phase 16; business-model §2–3, BR-18, BR-19; CLAUDE.md §16). Customer payment,
 * platform commission, fees/taxes, host earnings and payouts are separate ledger accounts; every money movement is
 * an idempotent, balanced journal posted in the same transaction as its cause.
 */
export function createEarningsService(deps: {
  db: Kysely<EarningsDb>;
  audit: AuditLog;
  cipher: FieldCipher;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'earningsContext'>;
  hosts: Pick<HostService, 'hostAccountStatus'>;
  payments: Pick<PaymentsModule, 'ledgerFeed'>;
  /** BR-18: an open dispute holds release (wired by the composition root). */
  hasOpenDispute?: (bookingId: string) => Promise<boolean>;
  /** Tax on platform revenue in basis points; 0 until the CA review (R-70). */
  taxBps?: number;
  now?: () => number;
}) {
  const { db, audit } = deps;
  const now = deps.now ?? Date.now;
  const taxBps = deps.taxBps ?? 0;
  const ledger = createLedger(db);

  async function splitFor(
    bookingId: string,
    executor?: AnyKyselyExecutor,
  ): Promise<{ split: Split; hostAccountId: string } | null> {
    const ctx = await deps.booking.earningsContext(bookingId, executor);
    if (!ctx) return null;
    return {
      hostAccountId: ctx.hostAccountId,
      split: captureSplit(
        {
          totalPaise: ctx.totalPaise,
          basePaise: ctx.basePaise,
          serviceFeePaise: ctx.serviceFeePaise,
          commissionBps: ctx.commissionBps,
        },
        taxBps,
      ),
    };
  }

  // ---------------------------------------------------------------- postings (in the payment transaction)

  async function postCapture(
    executor: AnyKyselyExecutor | undefined,
    e: { paymentId: string; bookingId: string; amountPaise: number },
  ) {
    const s = await splitFor(e.bookingId, executor);
    if (!s) return false;
    // Only the amount actually captured is split (it always equals the booking total; a mismatch never gets here).
    const split =
      e.amountPaise === s.split.totalPaise
        ? s.split
        : refundSplit(s.split, Math.min(e.amountPaise, s.split.totalPaise));
    const host = s.hostAccountId;
    return ledger.post(
      executor,
      {
        kind: 'PAYMENT_CAPTURED',
        key: `payment:${e.paymentId}:capture`,
        bookingId: e.bookingId,
        paymentId: e.paymentId,
        hostAccountId: host,
      },
      [
        { account: 'CUSTOMER_CLEARING', direction: 'DEBIT', amountPaise: split.totalPaise },
        { account: 'PLATFORM_SERVICE_FEE', direction: 'CREDIT', amountPaise: split.serviceFeePaise },
        { account: 'PLATFORM_COMMISSION', direction: 'CREDIT', amountPaise: split.commissionPaise },
        { account: 'TAX_PAYABLE', direction: 'CREDIT', amountPaise: split.taxPaise },
        {
          account: 'HOST_PENDING',
          hostAccountId: host,
          direction: 'CREDIT',
          amountPaise: split.hostNetPaise,
        },
      ],
    );
  }

  /**
   * A refund reverses each part proportionally. The host's share comes from what is still pending for this booking,
   * then from what was released, and after a payout it becomes a receivable offset from future payouts (BR-19).
   */
  async function postRefund(
    executor: AnyKyselyExecutor | undefined,
    e: { refundId: string; paymentId: string; bookingId: string; amountPaise: number },
  ) {
    const s = await splitFor(e.bookingId, executor);
    if (!s) return false;
    const r = refundSplit(s.split, Math.min(e.amountPaise, s.split.totalPaise));
    const host = s.hostAccountId;
    // Same per-host lock as payout runs: a refund and a payout never draw on one balance at once.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${host}`}, 0))`.execute(
      (executor as unknown as Kysely<EarningsDb> | undefined) ?? db,
    );
    const pending = Math.max(0, await ledger.balance(executor, 'HOST_PENDING', host, e.bookingId));
    const fromPending = Math.min(pending, r.hostNetPaise);
    const available = Math.max(0, await ledger.balance(executor, 'HOST_AVAILABLE', host));
    const fromAvailable = Math.min(available, r.hostNetPaise - fromPending);
    const receivable = r.hostNetPaise - fromPending - fromAvailable;
    const lines: Line[] = [
      { account: 'CUSTOMER_CLEARING', direction: 'CREDIT', amountPaise: r.totalPaise },
      { account: 'PLATFORM_SERVICE_FEE', direction: 'DEBIT', amountPaise: r.serviceFeePaise },
      { account: 'PLATFORM_COMMISSION', direction: 'DEBIT', amountPaise: r.commissionPaise },
      { account: 'TAX_PAYABLE', direction: 'DEBIT', amountPaise: r.taxPaise },
      { account: 'HOST_PENDING', hostAccountId: host, direction: 'DEBIT', amountPaise: fromPending },
      { account: 'HOST_AVAILABLE', hostAccountId: host, direction: 'DEBIT', amountPaise: fromAvailable },
      { account: 'HOST_RECEIVABLE', hostAccountId: host, direction: 'DEBIT', amountPaise: receivable },
    ];
    return ledger.post(
      executor,
      {
        kind: 'REFUND',
        key: `refund:${e.refundId}`,
        bookingId: e.bookingId,
        paymentId: e.paymentId,
        refundId: e.refundId,
        hostAccountId: host,
      },
      lines,
    );
  }

  deps.events.subscribe('payment.captured', async (e, executor) => {
    await postCapture(executor, e);
  });
  deps.events.subscribe('payment.refund_recorded', async (e, executor) => {
    await postRefund(executor, e);
  });

  // ---------------------------------------------------------------- jobs

  /** BR-18: pending earnings become available once the booking is over and the dispute window has passed. */
  async function releaseEarnings(): Promise<number> {
    const candidates = await db
      .selectFrom('ledger.entries as e')
      .innerJoin('ledger.accounts as a', 'a.id', 'e.account_id')
      .innerJoin('ledger.journals as j', 'j.id', 'e.journal_id')
      .select([
        'j.booking_id',
        'a.owner_id',
        sql<string>`sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END)`.as(
          'pending',
        ),
      ])
      .where('a.code', '=', 'HOST_PENDING')
      .where('j.booking_id', 'is not', null)
      .groupBy(['j.booking_id', 'a.owner_id'])
      .having(
        sql<boolean>`sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END) > 0`,
      )
      .limit(500)
      .execute();
    let released = 0;
    for (const c of candidates) {
      const ctx = await deps.booking.earningsContext(c.booking_id ?? '');
      if (!ctx || HOLDING.includes(ctx.status)) continue;
      if (now() < ctx.end + RELEASE_AFTER_END_HOURS * 3_600_000) continue;
      if (deps.hasOpenDispute && (await deps.hasOpenDispute(ctx.bookingId))) continue;
      const amount = Number(c.pending);
      const ok = await db.transaction().execute((trx) =>
        ledger.post(
          trx,
          {
            kind: 'EARNINGS_RELEASED',
            key: `booking:${ctx.bookingId}:release`,
            bookingId: ctx.bookingId,
            hostAccountId: ctx.hostAccountId,
          },
          [
            {
              account: 'HOST_PENDING',
              hostAccountId: ctx.hostAccountId,
              direction: 'DEBIT',
              amountPaise: amount,
            },
            {
              account: 'HOST_AVAILABLE',
              hostAccountId: ctx.hostAccountId,
              direction: 'CREDIT',
              amountPaise: amount,
            },
          ],
        ),
      );
      if (ok) released += 1;
    }
    return released;
  }

  /**
   * Payout run (weekly): offsets receivables, then pays available balances ≥ the minimum to verified, unheld payout
   * accounts of active hosts. One open payout per host. Payouts are MANUAL in the pilot: finance sends the bank/UPI
   * transfer and records the reference (no banking integration yet, PHASES.md Phase 16).
   */
  async function runPayouts(runDate = new Date(now()).toISOString().slice(0, 10)): Promise<number> {
    const hosts = await db
      .selectFrom('ledger.accounts')
      .select('owner_id')
      .where('code', 'in', ['HOST_AVAILABLE', 'HOST_RECEIVABLE'])
      .where('owner_id', 'is not', null)
      .distinct()
      .execute();
    let created = 0;
    for (const { owner_id: host } of hosts) {
      if (!host) continue;
      const made = await db.transaction().execute(async (trx) => {
        // Serialise per host (payout runs vs refunds drawing on the same balance).
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${host}`}, 0))`.execute(trx);
        let available = await ledger.balance(trx, 'HOST_AVAILABLE', host);
        const receivable = await ledger.balance(trx, 'HOST_RECEIVABLE', host);
        const offset = Math.min(Math.max(0, available), Math.max(0, receivable));
        if (offset > 0) {
          await ledger.post(
            trx,
            {
              kind: 'RECEIVABLE_OFFSET',
              key: `payout-run:${runDate}:${host}:offset`,
              hostAccountId: host,
              memo: 'refund after payout offset (BR-19)',
            },
            [
              { account: 'HOST_AVAILABLE', hostAccountId: host, direction: 'DEBIT', amountPaise: offset },
              { account: 'HOST_RECEIVABLE', hostAccountId: host, direction: 'CREDIT', amountPaise: offset },
            ],
          );
          available -= offset;
        }
        if (available < MIN_PAYOUT_PAISE) return false;
        // Restricted or suspended hosts keep their balance until support resolves it.
        if ((await deps.hosts.hostAccountStatus(host)) !== 'ACTIVE') return false;
        const account = await trx
          .selectFrom('payouts.payout_accounts')
          .select(['id', 'hold_until'])
          .where('host_account_id', '=', host)
          .where('status', '=', 'VERIFIED')
          .executeTakeFirst();
        if (!account || (account.hold_until && account.hold_until.getTime() > now())) return false;
        const open = await trx
          .selectFrom('payouts.payouts')
          .select('id')
          .where('host_account_id', '=', host)
          .where('status', '=', 'PROCESSING')
          .executeTakeFirst();
        if (open) return false;
        const id = uuidv7();
        await trx
          .insertInto('payouts.payouts')
          .values({
            id,
            host_account_id: host,
            payout_account_id: account.id,
            amount_paise: available,
            status: 'PROCESSING',
            provider: 'MANUAL',
            idempotency_key: `payout-run:${runDate}:${host}`,
          })
          .onConflict((oc) => oc.column('idempotency_key').doNothing())
          .execute();
        return ledger.post(
          trx,
          { kind: 'PAYOUT_CREATED', key: `payout:${id}:create`, payoutId: id, hostAccountId: host },
          [
            { account: 'HOST_AVAILABLE', hostAccountId: host, direction: 'DEBIT', amountPaise: available },
            { account: 'HOST_IN_PAYOUT', hostAccountId: host, direction: 'CREDIT', amountPaise: available },
          ],
        );
      });
      if (made) created += 1;
    }
    return created;
  }

  /** Backfill / repair: captured payments or recorded refunds without their journal (idempotent by key). */
  async function backfill(): Promise<number> {
    const feed = await deps.payments.ledgerFeed();
    const keys = new Set(
      (
        await db
          .selectFrom('ledger.journals')
          .select('idempotency_key')
          .where('kind', 'in', ['PAYMENT_CAPTURED', 'REFUND'])
          .where(sql<boolean>`created_at > now() - interval '31 days'`)
          .execute()
      ).map((j) => j.idempotency_key),
    );
    let n = 0;
    for (const p of feed.captured.filter((x) => !keys.has(`payment:${x.paymentId}:capture`))) {
      if (await db.transaction().execute((trx) => postCapture(trx, p))) n += 1;
    }
    for (const r of feed.refunds.filter((x) => !keys.has(`refund:${x.refundId}`))) {
      if (await db.transaction().execute((trx) => postRefund(trx, r))) n += 1;
    }
    return n;
  }

  // ---------------------------------------------------------------- payout accounts (host)

  function maskedAccount(row: {
    id: string;
    method: string;
    holder_name: string;
    display_last4: string;
    ifsc: string | null;
    status: string;
    hold_until: Date | null;
    created_at: Date;
  }) {
    return {
      id: row.id,
      method: row.method as 'UPI' | 'BANK',
      holderName: row.holder_name,
      display:
        row.method === 'UPI'
          ? `••••${row.display_last4}`
          : `A/c ••••${row.display_last4}${row.ifsc ? ` · ${row.ifsc}` : ''}`,
      status: row.status as 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'REPLACED',
      holdUntil: row.hold_until && row.hold_until.getTime() > now() ? row.hold_until : null,
      createdAt: row.created_at,
    };
  }

  async function setPayoutAccount(
    host: Host,
    input:
      | { method: 'UPI'; holderName: string; vpa: string }
      | { method: 'BANK'; holderName: string; accountNumber: string; ifsc: string },
    requestId: string,
  ) {
    if (host.role !== 'OWNER') throw earningsErrors.ownerOnly(); // H-14: owner-only payout control
    const details =
      input.method === 'UPI'
        ? input.vpa.trim().toLowerCase()
        : `${input.accountNumber.replace(/\s/g, '')}|${input.ifsc.toUpperCase()}`;
    if (input.method === 'UPI' && !/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/.test(details)) {
      throw earningsErrors.invalidDetails('Enter a UPI ID like name@bank.');
    }
    if (input.method === 'BANK') {
      if (!/^\d{9,18}$/.test(input.accountNumber.replace(/\s/g, '')))
        throw earningsErrors.invalidDetails('Account numbers have 9 to 18 digits.');
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.ifsc.toUpperCase()))
        throw earningsErrors.invalidDetails('IFSC looks like HDFC0001234.');
    }
    const last4 =
      input.method === 'UPI'
        ? (details.split('@')[0]?.slice(-4) ?? '')
        : input.accountNumber.replace(/\s/g, '').slice(-4);
    const id = uuidv7();
    await db.transaction().execute(async (trx) => {
      const replaced = await trx
        .updateTable('payouts.payout_accounts')
        .set({ status: 'REPLACED' })
        .where('host_account_id', '=', host.hostAccountId)
        .where('status', 'in', ['PENDING_VERIFICATION', 'VERIFIED'])
        .returning('id')
        .execute();
      await trx
        .insertInto('payouts.payout_accounts')
        .values({
          id,
          host_account_id: host.hostAccountId,
          method: input.method,
          holder_name: input.holderName.trim(),
          details_enc: deps.cipher.encrypt(details, DETAILS_CONTEXT),
          display_last4: last4.padStart(2, '•'),
          ifsc: input.method === 'BANK' ? input.ifsc.toUpperCase() : null,
          status: 'PENDING_VERIFICATION',
          // A change of payout details holds payouts for 72 h (account-takeover protection, R-17).
          hold_until:
            replaced.length > 0 ? new Date(now() + PAYOUT_ACCOUNT_CHANGE_HOLD_HOURS * 3_600_000) : null,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: replaced.length ? 'payout_account.changed' : 'payout_account.added',
          entityKind: 'host_account',
          entityId: host.hostAccountId,
          metadata: { method: input.method },
          requestId,
        },
        trx,
      );
    });
    return payoutAccount(host.hostAccountId);
  }

  async function payoutAccount(hostAccountId: string) {
    const row = await db
      .selectFrom('payouts.payout_accounts')
      .selectAll()
      .where('host_account_id', '=', hostAccountId)
      .where('status', 'in', ['PENDING_VERIFICATION', 'VERIFIED'])
      .executeTakeFirst();
    return row ? maskedAccount(row) : null;
  }

  // ---------------------------------------------------------------- views

  async function hostEarnings(hostAccountId: string) {
    const [pending, available, inPayout, receivable] = await Promise.all([
      ledger.balance(undefined, 'HOST_PENDING', hostAccountId),
      ledger.balance(undefined, 'HOST_AVAILABLE', hostAccountId),
      ledger.balance(undefined, 'HOST_IN_PAYOUT', hostAccountId),
      ledger.balance(undefined, 'HOST_RECEIVABLE', hostAccountId),
    ]);
    const paid = await db
      .selectFrom('payouts.payouts')
      .select(sql<string>`coalesce(sum(amount_paise), 0)`.as('s'))
      .where('host_account_id', '=', hostAccountId)
      .where('status', '=', 'PAID')
      .executeTakeFirstOrThrow();

    // Per booking: what the customer paid, the platform's parts, refunds, and the host's net.
    const rows = await db
      .selectFrom('ledger.entries as e')
      .innerJoin('ledger.accounts as a', 'a.id', 'e.account_id')
      .innerJoin('ledger.journals as j', 'j.id', 'e.journal_id')
      .select([
        'j.booking_id',
        sql<Date>`min(j.created_at)`.as('first_at'),
        sql<string>`sum(CASE WHEN j.kind = 'PAYMENT_CAPTURED' AND a.code = 'CUSTOMER_CLEARING' THEN e.amount_paise ELSE 0 END)`.as(
          'paid',
        ),
        sql<string>`sum(CASE WHEN j.kind = 'REFUND' AND a.code = 'CUSTOMER_CLEARING' THEN e.amount_paise ELSE 0 END)`.as(
          'refunded',
        ),
        sql<string>`sum(CASE WHEN a.code = 'PLATFORM_SERVICE_FEE' THEN (CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END) ELSE 0 END)`.as(
          'fee',
        ),
        sql<string>`sum(CASE WHEN a.code = 'PLATFORM_COMMISSION' THEN (CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END) ELSE 0 END)`.as(
          'commission',
        ),
        sql<string>`sum(CASE WHEN a.code = 'TAX_PAYABLE' THEN (CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END) ELSE 0 END)`.as(
          'tax',
        ),
        sql<string>`sum(CASE WHEN a.code = 'HOST_PENDING' THEN (CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END) ELSE 0 END)`.as(
          'pending',
        ),
        sql<string>`sum(CASE WHEN j.kind = 'EARNINGS_RELEASED' AND a.code = 'HOST_AVAILABLE' THEN e.amount_paise ELSE 0 END)`.as(
          'released',
        ),
      ])
      .where('j.host_account_id', '=', hostAccountId)
      .where('j.booking_id', 'is not', null)
      .groupBy('j.booking_id')
      .orderBy(sql`min(j.created_at)`, 'desc')
      .limit(100)
      .execute();
    const bookings = rows.map((r) => {
      const paidPaise = Number(r.paid);
      const refundedPaise = Number(r.refunded);
      const fee = Number(r.fee);
      const commission = Number(r.commission);
      const tax = Number(r.tax);
      const net = paidPaise - refundedPaise - fee - commission - tax;
      return {
        bookingId: r.booking_id ?? '',
        customerPaidPaise: paidPaise,
        refundedPaise,
        grossPaise: paidPaise - refundedPaise - fee, // booking value the host earned on (after refunds)
        serviceFeePaise: fee,
        commissionPaise: commission,
        taxPaise: tax,
        netPaise: net,
        status:
          Number(r.pending) > 0
            ? ('PENDING' as const)
            : Number(r.released) > 0
              ? ('RELEASED' as const)
              : ('SETTLED' as const),
        firstAt: r.first_at,
      };
    });
    return {
      balances: {
        pendingPaise: pending,
        availablePaise: available,
        inPayoutPaise: inPayout,
        paidPaise: Number(paid.s),
        receivablePaise: receivable,
      },
      releaseAfterHours: RELEASE_AFTER_END_HOURS,
      minPayoutPaise: MIN_PAYOUT_PAISE,
      bookings,
    };
  }

  async function hostPayouts(hostAccountId: string) {
    const rows = await db
      .selectFrom('payouts.payouts')
      .selectAll()
      .where('host_account_id', '=', hostAccountId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map(payoutView);
  }

  function payoutView(p: {
    id: string;
    host_account_id: string;
    amount_paise: string;
    status: string;
    provider_reference: string | null;
    failure_reason: string | null;
    created_at: Date;
    settled_at: Date | null;
  }) {
    return {
      id: p.id,
      hostAccountId: p.host_account_id,
      amountPaise: Number(p.amount_paise),
      status: p.status as 'PROCESSING' | 'PAID' | 'FAILED',
      reference: p.provider_reference,
      failureReason: p.failure_reason,
      createdAt: p.created_at,
      settledAt: p.settled_at,
    };
  }

  // ---------------------------------------------------------------- finance admin

  async function pendingPayoutAccounts() {
    const rows = await db
      .selectFrom('payouts.payout_accounts')
      .selectAll()
      .where('status', '=', 'PENDING_VERIFICATION')
      .orderBy('created_at')
      .limit(200)
      .execute();
    // Finance sees the full details to run the penny-drop / name check (A-05); the reveal is audited.
    return rows.map((r) => ({
      ...maskedAccount(r),
      hostAccountId: r.host_account_id,
      details: deps.cipher.decrypt(r.details_enc, DETAILS_CONTEXT),
    }));
  }

  async function reviewPayoutAccount(
    adminId: string,
    accountId: string,
    decision: 'VERIFIED' | 'REJECTED',
    requestId: string,
  ) {
    const res = await db
      .updateTable('payouts.payout_accounts')
      .set({
        status: decision,
        ...(decision === 'VERIFIED' ? { verified_at: new Date(now()), verified_by: adminId } : {}),
      })
      .where('id', '=', accountId)
      .where('status', '=', 'PENDING_VERIFICATION')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
    const acct = await db
      .selectFrom('payouts.payout_accounts')
      .select('host_account_id')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    await deps.events.publish(
      'payout_account.reviewed',
      { accountId, hostAccountId: acct.host_account_id, decision },
      db,
    );
    await audit.record({
      actorKind: 'ADMIN',
      actorId: adminId,
      action: `payout_account.${decision.toLowerCase()}`,
      entityKind: 'payout_account',
      entityId: accountId,
      requestId,
    });
  }

  async function adminPayouts(f: {
    status?: string | undefined;
    hostAccountId?: string | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('payouts.payouts');
    if (f.status) q = q.where('status', '=', f.status);
    if (f.hostAccountId) q = q.where('host_account_id', '=', f.hostAccountId);
    const [rows, total] = await Promise.all([
      q.selectAll().orderBy('created_at', 'desc').offset(f.offset).limit(f.limit).execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(payoutView), offset: f.offset, limit: f.limit, total: Number(total.n) };
  }

  async function openPayouts() {
    const rows = await db
      .selectFrom('payouts.payouts')
      .selectAll()
      .where('status', '=', 'PROCESSING')
      .orderBy('created_at')
      .limit(500)
      .execute();
    return rows.map(payoutView);
  }

  /** Finance records the outcome of the bank/UPI transfer. */
  async function settlePayout(
    adminId: string,
    payoutId: string,
    outcome: { status: 'PAID'; reference: string } | { status: 'FAILED'; reason: string },
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const p = await trx
        .selectFrom('payouts.payouts')
        .selectAll()
        .where('id', '=', payoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw errors.notFound();
      if (p.status !== 'PROCESSING') throw earningsErrors.transitionNotAllowed(p.status);
      const amount = Number(p.amount_paise);
      await trx
        .updateTable('payouts.payouts')
        .set({
          status: outcome.status,
          settled_at: new Date(now()),
          settled_by: adminId,
          ...(outcome.status === 'PAID'
            ? { provider_reference: outcome.reference }
            : { failure_reason: outcome.reason }),
        })
        .where('id', '=', payoutId)
        .execute();
      await ledger.post(
        trx,
        {
          kind: outcome.status === 'PAID' ? 'PAYOUT_PAID' : 'PAYOUT_FAILED',
          key: `payout:${payoutId}:${outcome.status.toLowerCase()}`,
          payoutId,
          hostAccountId: p.host_account_id,
        },
        outcome.status === 'PAID'
          ? [
              {
                account: 'HOST_IN_PAYOUT',
                hostAccountId: p.host_account_id,
                direction: 'DEBIT',
                amountPaise: amount,
              },
              { account: 'PAYOUT_CASH', direction: 'CREDIT', amountPaise: amount },
            ]
          : [
              {
                account: 'HOST_IN_PAYOUT',
                hostAccountId: p.host_account_id,
                direction: 'DEBIT',
                amountPaise: amount,
              },
              {
                account: 'HOST_AVAILABLE',
                hostAccountId: p.host_account_id,
                direction: 'CREDIT',
                amountPaise: amount,
              },
            ],
      );
      await deps.events.publish(
        'payout.settled',
        { payoutId, hostAccountId: p.host_account_id, amountPaise: amount, status: outcome.status },
        trx,
      );
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: adminId,
          action: `payout.${outcome.status.toLowerCase()}`,
          entityKind: 'payout',
          entityId: payoutId,
          metadata: { amountPaise: amount },
          requestId,
        },
        trx,
      );
    });
  }

  return {
    postCapture,
    postRefund,
    releaseEarnings,
    runPayouts,
    backfill,
    setPayoutAccount,
    payoutAccount,
    hostEarnings,
    hostPayouts,
    pendingPayoutAccounts,
    reviewPayoutAccount,
    openPayouts,
    adminPayouts,
    settlePayout,
    trialBalance: ledger.trialBalance,
  };
}

export type EarningsService = ReturnType<typeof createEarningsService>;
