import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../../platform/audit/audit-log.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import '../domain/events.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import type { AssetsModule, BookingContext } from '../../assets/index.ts';
import {
  assetCheck,
  maxConcurrent,
  type AvailabilityModule,
  type UnavailableReason,
} from '../../availability/index.ts';
import type { IdentityModule } from '../../identity/index.ts';
import {
  computeQuote,
  PRICING_CONFIG,
  type BookingMode,
  type PricingModule,
  type QuoteLine,
} from '../../pricing/index.ts';
import type { PropertiesModule } from '../../properties/index.ts';
import { formatPlate, type UsersModule } from '../../users/index.ts';
import {
  CANCELLATION_POLICIES,
  refundFor,
  type Canceller,
  type PolicySnapshot,
} from '../domain/cancellation.ts';
import { nextStatus, type BookingAction, type BookingStatus } from '../domain/state-machine.ts';
import type { BookingDb, BookingsTable } from '../infrastructure/tables.ts';
import { bookingReservationSource, notLapsed } from './reservations.ts';
import { createIssueService, type IssueKind } from './issue-service.ts';
import { createSeriesService } from './series-service.ts';

export const HOLD_MINUTES = 10; // BR-10
export const APPROVAL_HOURS = 12; // BR-10, never past the start
const REVEAL_AFTER_END_MS = 24 * 3_600_000; // L-6
export const NO_SHOW_GRACE_MINUTES = 30; // BR-26
const MAX_WINDOW_MS = 35 * 86_400_000;
const VEHICLE_ORDER = ['HATCHBACK', 'SEDAN', 'SUV', 'MUV'];

type BookingRow = Selectable<BookingsTable> & { live: boolean; start_ms: number };
type Actor = { kind: 'CUSTOMER' | 'HOST' | 'PLATFORM_ADMIN' | 'SYSTEM'; userId: string | null };

export const bookingErrors = {
  notCleared: () =>
    new DomainError({
      code: 'booking.customer_not_cleared',
      status: 403,
      title: 'Your account needs a quick check before you can book',
      detail:
        "We're running a small pilot and check every new driver's vehicle papers and ID first. We'll contact you, or write to support to get started.",
    }),
  listingUnavailable: () =>
    new DomainError({
      code: 'booking.listing_unavailable',
      status: 409,
      title: "This listing isn't taking bookings right now",
    }),
  unavailable: (reason: UnavailableReason | 'LEAD_TIME' | 'DURATION' | 'CAPACITY') =>
    new DomainError({
      code: 'booking.unavailable',
      status: 409,
      title:
        reason === 'RESERVED' || reason === 'CAPACITY'
          ? 'Just booked by someone else'
          : 'Not available for that time',
      detail:
        {
          CLOSED: "The space isn't open then.",
          BLOCKED: "The host isn't available then.",
          RESERVED: 'Another booking took this time. Try a different time or a nearby space.',
          CAPACITY: 'The building has reached its limit for visitor vehicles then.',
          NO_UNITS: 'No spaces are configured.',
          INVALID_WINDOW: 'Check the start and end times.',
          LEAD_TIME: 'The host needs more notice for this booking.',
          DURATION: "That length of stay isn't allowed for this listing.",
        }[reason] ?? 'Not available.',
    }),
  quoteInvalid: (detail: string) =>
    new DomainError({
      code: 'booking.quote_invalid',
      status: 400,
      title: "We can't price that booking",
      detail,
    }),
  quoteExpired: () =>
    new DomainError({
      code: 'booking.quote_expired',
      status: 409,
      title: 'Your price has expired',
      detail: 'Get a new price and try again.',
    }),
  idempotencyConflict: () =>
    new DomainError({
      code: 'booking.idempotency_conflict',
      status: 409,
      title: 'This request was already used for a different booking',
      detail: 'Send a new Idempotency-Key for a new booking.',
    }),
  vehicleIncompatible: (detail: string) =>
    new DomainError({
      code: 'booking.vehicle_incompatible',
      status: 400,
      title: "Your vehicle doesn't fit this space",
      detail,
    }),
  vehicleNotFound: () =>
    new DomainError({
      code: 'vehicle.not_found',
      status: 404,
      title: 'Vehicle not found',
      detail: 'Add your vehicle first.',
    }),
  ownListing: () =>
    new DomainError({
      code: 'booking.own_listing',
      status: 409,
      title: "You can't book your own listing",
      detail: 'To block time for yourself, use your calendar.',
    }),
  transitionNotAllowed: (from: string) =>
    new DomainError({
      code: 'booking.transition_not_allowed',
      status: 409,
      title: 'That action is not available for this booking',
      detail: `The booking is ${from.toLowerCase().replaceAll('_', ' ')}.`,
    }),
};

export function createBookingService(deps: {
  db: Kysely<BookingDb>;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  identity: IdentityModule;
  users: UsersModule;
  properties: PropertiesModule;
  assets: AssetsModule;
  availability: AvailabilityModule;
  pricing: PricingModule;
  events: DomainEventBus;
  customerCleared?: (customerId: string) => Promise<boolean>;
  now?: () => number;
}) {
  const { db, audit, events } = deps;
  const now = deps.now ?? Date.now;
  const reservations = bookingReservationSource(db);

  // ------------------------------------------------------------------ availability (authoritative)

  /** With an executor, every read runs on that transaction (never the pool: no connection waits inside a transaction). */
  async function evaluate(
    ctx: BookingContext,
    timezone: string,
    start: number,
    end: number,
    mode: BookingMode,
    executor?: Transaction<BookingDb>,
  ) {
    if (!(end > start) || end - start > MAX_WINDOW_MS)
      return { ok: false as const, reason: 'INVALID_WINDOW' as const };
    if (start < now() + ctx.leadMinutes * 60_000) return { ok: false as const, reason: 'LEAD_TIME' as const };
    const minutes = (end - start) / 60_000;
    if (
      (mode === 'HOURLY' || mode === 'CHARGING_SESSION') &&
      (minutes < ctx.minMinutes || minutes > ctx.maxMinutes)
    ) {
      return { ok: false as const, reason: 'DURATION' as const };
    }
    const [rules, exceptions] = await Promise.all([
      deps.availability.listRules(ctx.assetId, executor),
      deps.availability.listExceptions(ctx.assetId, { from: start, to: end }, executor),
    ]);
    const unitIds = ctx.units.map((u) => u.id);
    const held = await reservations.holdingReservations(
      unitIds,
      start,
      end + ctx.bufferMinutes * 60_000,
      executor,
    );
    const result = assetCheck(
      {
        timezone,
        bufferMinutes: ctx.bufferMinutes,
        unitIds,
        rules: rules.map((r) => ({
          weekdays: r.weekdays,
          startLocal: r.startLocal,
          endLocal: r.endLocal,
          validFrom: r.validFrom ?? '1970-01-01',
          validTo: r.validTo ?? null,
        })),
        exceptions,
        reservations: held,
      },
      start,
      end,
    );
    return result.available
      ? { ok: true as const, unitIds: result.unitIds }
      : { ok: false as const, reason: result.reason };
  }

  function vehicleFits(
    ctx: BookingContext,
    vehicle: { vehicleClass: string; isEv: boolean; connectors: string[] },
  ) {
    if (VEHICLE_ORDER.indexOf(vehicle.vehicleClass) > VEHICLE_ORDER.indexOf(ctx.maxVehicleClass)) {
      throw bookingErrors.vehicleIncompatible(
        `This space fits up to a ${ctx.maxVehicleClass.toLowerCase()}.`,
      );
    }
    if (ctx.assetType === 'EV_CHARGING') {
      if (!vehicle.isEv)
        throw bookingErrors.vehicleIncompatible('EV charging spaces are for electric vehicles.');
      if (!vehicle.connectors.some((c) => ctx.connectors.includes(c))) {
        throw bookingErrors.vehicleIncompatible("Your vehicle's connector doesn't match this charger."); // BR-12
      }
    }
  }

  /** A host's own listings are not bookable by them or their team (self-dealing; trust-and-safety §5). */
  async function refuseOwnListing(customerId: string, hostAccountId: string) {
    const access = await deps.identity.hosts.hostAccessFor(customerId);
    if (access?.hostAccountId === hostAccountId) throw bookingErrors.ownListing();
  }

  async function capAllows(
    trx: Transaction<BookingDb>,
    propertyId: string,
    cap: number | null,
    start: number,
    end: number,
  ) {
    if (cap === null) return true;
    const present = await reservations.forProperty(propertyId, start, end, trx);
    return maxConcurrent([...present, { start, end }], start, end) <= cap;
  }

  // Monthly arrangements share the engine's own checks (declared below; hoisted function declarations).
  const series = createSeriesService({
    db,
    audit,
    now,
    assets: deps.assets,
    properties: deps.properties,
    identity: deps.identity,
    users: deps.users,
    evaluate: (ctx, tz, start, end, mode, trx) => evaluate(ctx, tz, start, end, mode, trx),
    expireLapsedOn: (trx, unitIds, start, end, requestId) =>
      expireLapsedOn(trx, unitIds, start, end, requestId),
    capAllows,
    closed: (trx, bookingId, requestId) => lifecycle(trx, bookingId, 'CANCELLED', requestId),
    refundDue: (trx, bookingId, amountPaise, cause, requestId) =>
      events.publish('booking.refund_due', { bookingId, amountPaise, cause, requestId }, trx),
  });

  /** Lock order: series → property → asset → bookings. A booking of a series locks its series row first. */
  async function lockSeriesOf(trx: Transaction<BookingDb>, bookingId: string) {
    const row = await trx
      .selectFrom('booking.bookings')
      .select('series_id')
      .where('id', '=', bookingId)
      .executeTakeFirst();
    if (row?.series_id) {
      await trx
        .selectFrom('booking.booking_series')
        .select('id')
        .where('id', '=', row.series_id)
        .forUpdate()
        .execute();
    }
  }

  // ------------------------------------------------------------------ quotes (BR-11)

  async function quote(
    customerId: string,
    input: { assetId: string; mode: BookingMode; start: number; end: number },
  ) {
    await deps.rateLimiter.enforce({
      key: `booking-quote:customer1h:${customerId}`,
      limit: 120,
      windowSeconds: 3600,
    });
    const ctx = await deps.assets.bookingContext(input.assetId);
    if (!ctx || ctx.status !== 'PUBLISHED') throw bookingErrors.listingUnavailable();
    await refuseOwnListing(customerId, ctx.hostAccountId);
    const timezone = (await deps.properties.timezoneOf(ctx.propertyId)) ?? 'Asia/Kolkata';
    const rates = await deps.pricing.currentRates(input.assetId);
    const priced = computeQuote({
      rates: rates.map((r) => ({
        ...r,
        overnightStart: r.overnightStart ?? null,
        overnightEnd: r.overnightEnd ?? null,
      })),
      mode: input.mode,
      start: input.start,
      end: input.end,
      timezone,
    });
    if (!priced.ok) {
      throw bookingErrors.quoteInvalid(
        {
          MODE_NOT_OFFERED: "This listing doesn't offer that booking type.",
          INVALID_WINDOW: 'Choose a start and end time in whole minutes.',
          OVERNIGHT_WINDOW_MISMATCH: "Overnight bookings must match the listing's overnight hours.",
          MONTHLY_WINDOW_MISMATCH: 'Monthly bookings run for exactly one month from the start.',
        }[priced.error],
      );
    }
    const check = await evaluate(ctx, timezone, input.start, input.end, input.mode);
    if (!check.ok) throw bookingErrors.unavailable(check.reason);
    const policy = CANCELLATION_POLICIES[ctx.cancellationPolicy];
    const stored = await deps.pricing.saveQuote({
      customerId,
      assetId: input.assetId,
      mode: input.mode,
      start: input.start,
      end: input.end,
      snapshot: { ...priced.quote, policy },
      totalPaise: priced.quote.totalPaise,
      configVersion: priced.quote.configVersion,
    });
    return {
      quoteId: stored.id,
      assetId: input.assetId,
      mode: input.mode,
      start: new Date(input.start),
      end: new Date(input.end),
      lines: priced.quote.lines,
      totalPaise: priced.quote.totalPaise,
      expiresAt: stored.expiresAt,
      approvalRequired: ctx.approvalRequired || input.mode === 'MONTHLY',
      cancellationPolicy: policy,
    };
  }

  // ------------------------------------------------------------------ create (BR-07 … BR-11, BR-06, BR-33)

  /** SYSTEM transition of already-locked rows, with history (expiry, completion). */
  const FINAL = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED', 'NO_SHOW']);
  /** Lifecycle events for other modules (access), published inside the changing transaction. */
  async function lifecycle(trx: Transaction<BookingDb>, bookingId: string, to: string, requestId: string) {
    if (to === 'CONFIRMED') {
      const b = await trx
        .selectFrom('booking.bookings')
        .select([
          'id',
          'property_id',
          'asset_id',
          'unit_id',
          'customer_id',
          'vehicle_id',
          sql<number>`extract(epoch FROM lower(period)) * 1000`.as('s'),
          sql<number>`extract(epoch FROM upper(period)) * 1000`.as('e'),
        ])
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow();
      await events.publish(
        'booking.confirmed',
        {
          bookingId,
          propertyId: b.property_id,
          assetId: b.asset_id,
          unitId: b.unit_id,
          customerId: b.customer_id,
          vehicleId: b.vehicle_id,
          start: Number(b.s),
          end: Number(b.e),
          requestId,
        },
        trx,
      );
    } else if (FINAL.has(to)) {
      await events.publish('booking.closed', { bookingId, status: to as 'COMPLETED', requestId }, trx);
    }
  }

  async function systemTransition(
    trx: Transaction<BookingDb>,
    rows: { id: string; status: string }[],
    to: BookingStatus,
    reason: string,
    requestId: string,
  ) {
    if (rows.length === 0) return 0;
    await trx
      .updateTable('booking.bookings')
      .set({ status: to, version: sql<number>`version + 1` })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    await trx
      .insertInto('booking.booking_events')
      .values(
        rows.map((r) => ({
          booking_id: r.id,
          from_status: r.status,
          to_status: to,
          actor_kind: 'SYSTEM',
          actor_id: null,
          reason,
          request_id: requestId,
        })),
      )
      .execute();
    for (const r of rows) await lifecycle(trx, r.id, to, requestId);
    return rows.length;
  }

  const lapsedHolds = (trx: Transaction<BookingDb>) =>
    trx
      .selectFrom('booking.bookings as b')
      .select(['b.id', 'b.status'])
      .where('b.status', 'in', ['PENDING_PAYMENT', 'AWAITING_HOST_APPROVAL'])
      .where(sql<boolean>`NOT ${notLapsed}`);

  /** Lapsed holds still sit in the exclusion constraint until marked EXPIRED: clear the ones in our way (D-036). */
  async function expireLapsedOn(
    trx: Transaction<BookingDb>,
    unitIds: string[],
    start: number,
    end: number,
    requestId: string,
  ) {
    if (unitIds.length === 0) return;
    const lapsed = await lapsedHolds(trx)
      .where('b.unit_id', 'in', unitIds)
      .where(
        sql<boolean>`b.blocked_period && tstzrange(to_timestamp(${start / 1000}), to_timestamp(${end / 1000}), '[)')`,
      )
      .forUpdate()
      .execute();
    await systemTransition(trx, lapsed, 'EXPIRED', 'hold lapsed', requestId);
  }

  async function createBooking(
    customerId: string,
    input: { quoteId: string; vehicleId: string; idempotencyKey: string },
    requestId: string,
  ): Promise<{ bookingId: string; replayed: boolean }> {
    // BR-09: a retry with the same key returns the original booking; reusing a key for something else is refused.
    const existing = await db
      .selectFrom('booking.bookings')
      .select(['id', 'quote_id'])
      .where('customer_id', '=', customerId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.quote_id !== input.quoteId) throw bookingErrors.idempotencyConflict();
      return { bookingId: existing.id, replayed: true };
    }
    await deps.rateLimiter.enforce({
      key: `booking-create:customer1h:${customerId}`,
      limit: 20,
      windowSeconds: 3600,
    });
    // Controlled pilot (D-168): only customers trust & safety has cleared may book.
    if (deps.customerCleared && !(await deps.customerCleared(customerId))) throw bookingErrors.notCleared();

    const vehicle = await deps.users.ownedVehicle(customerId, input.vehicleId);
    if (!vehicle) throw bookingErrors.vehicleNotFound();
    // Which property to lock first; re-read under lock below. Outside the transaction (it must not wait on the pool).
    const target = await deps.pricing.lockQuote(input.quoteId);
    const preview = target ? await deps.assets.bookingContext(target.assetId) : null;
    if (preview) await refuseOwnListing(customerId, preview.hostAccountId);

    try {
      return await db.transaction().execute(async (trx) => {
        const quoteRow = await deps.pricing.lockQuote(input.quoteId, trx);
        if (!quoteRow || quoteRow.customerId !== customerId) throw errors.notFound();
        if (quoteRow.used) {
          // A parallel retry with the same key got the quote lock first and committed: replay its booking (BR-09).
          const winner = await trx
            .selectFrom('booking.bookings')
            .select(['id', 'idempotency_key'])
            .where('quote_id', '=', quoteRow.id)
            .executeTakeFirst();
          if (winner?.idempotency_key === input.idempotencyKey)
            return { bookingId: winner.id, replayed: true };
          throw bookingErrors.quoteExpired();
        }
        if (quoteRow.expired) throw bookingErrors.quoteExpired();

        // Lock order: property (if capped) → asset FOR SHARE → bookings (database-design §6.4, D-086).
        if (!preview || preview.assetId !== quoteRow.assetId) throw bookingErrors.listingUnavailable();
        const property = await deps.properties.lockForBooking(preview.propertyId, trx);
        if (!property) throw bookingErrors.listingUnavailable();
        const ctx = await deps.assets.bookingContext(quoteRow.assetId, trx);
        if (!ctx || ctx.status !== 'PUBLISHED') throw bookingErrors.listingUnavailable();
        if (!['NOT_REQUIRED', 'PARTICIPATING'].includes(property.participationStatus))
          throw bookingErrors.listingUnavailable();
        vehicleFits(ctx, vehicle);

        const { start, end } = quoteRow;
        const unitIds = ctx.units.map((u) => u.id);
        await expireLapsedOn(trx, unitIds, start, end + ctx.bufferMinutes * 60_000, requestId);

        // Re-check availability immediately before committing (BR-07, CLAUDE.md §13).
        const check = await evaluate(ctx, property.timezone, start, end, quoteRow.mode, trx);
        if (!check.ok) throw bookingErrors.unavailable(check.reason);

        if (!(await capAllows(trx, ctx.propertyId, property.outsiderCap, start, end)))
          throw bookingErrors.unavailable('CAPACITY');

        const id = uuidv7();
        // D-104: a monthly arrangement always starts as a request the host approves (D-017).
        const monthly = quoteRow.mode === 'MONTHLY';
        const status: BookingStatus =
          ctx.approvalRequired || monthly ? 'AWAITING_HOST_APPROVAL' : 'PENDING_PAYMENT';
        const snapshot = quoteRow.snapshot as {
          policy: PolicySnapshot;
          lines: QuoteLine[];
          totalPaise: number;
        };
        let allocated: string | null = null;
        for (const unitId of check.unitIds) {
          await sql`SAVEPOINT allocate_unit`.execute(trx);
          try {
            const seriesId = monthly
              ? await series.createForFirstPeriod(
                  trx,
                  {
                    customerId,
                    vehicleId: vehicle.id,
                    ctx,
                    unitId,
                    timezone: property.timezone,
                    start,
                    snapshot,
                  },
                  requestId,
                )
              : null;
            await trx
              .insertInto('booking.bookings')
              .values({
                id,
                customer_id: customerId,
                vehicle_id: vehicle.id,
                asset_id: ctx.assetId,
                unit_id: unitId,
                host_account_id: ctx.hostAccountId,
                property_id: ctx.propertyId,
                asset_type: ctx.assetType,
                mode: quoteRow.mode,
                period: sql`tstzrange(to_timestamp(${start / 1000}), to_timestamp(${end / 1000}), '[)')`,
                buffer_minutes: ctx.bufferMinutes,
                status,
                hold_expires_at:
                  status === 'PENDING_PAYMENT'
                    ? sql<Date>`now() + make_interval(mins => ${HOLD_MINUTES})`
                    : null,
                approval_expires_at:
                  status === 'AWAITING_HOST_APPROVAL'
                    ? sql<Date>`least(now() + make_interval(hours => ${APPROVAL_HOURS}), to_timestamp(${start / 1000}))`
                    : null,
                quote_id: quoteRow.id,
                price_snapshot: JSON.stringify(quoteRow.snapshot),
                policy_snapshot: JSON.stringify(snapshot.policy),
                total_paise: quoteRow.totalPaise,
                idempotency_key: input.idempotencyKey,
                series_id: seriesId,
                period_index: seriesId ? 1 : null,
              })
              .execute();
            await sql`RELEASE SAVEPOINT allocate_unit`.execute(trx);
            allocated = unitId;
            break;
          } catch (error) {
            await sql`ROLLBACK TO SAVEPOINT allocate_unit`.execute(trx);
            // A concurrent booking took this unit between our check and insert: try the next unit (BR-08 backstop).
            if ((error as { code?: string; constraint?: string }).constraint === 'bookings_no_overlap')
              continue;
            throw error;
          }
        }
        if (!allocated) throw bookingErrors.unavailable('RESERVED');

        await deps.pricing.markQuoteUsed(quoteRow.id, trx);
        if (status === 'AWAITING_HOST_APPROVAL')
          await events.publish('booking.requested', { bookingId: id, requestId }, trx);
        await trx
          .insertInto('booking.booking_events')
          .values({
            booking_id: id,
            from_status: null,
            to_status: status,
            actor_kind: 'CUSTOMER',
            actor_id: customerId,
            reason: 'created',
            request_id: requestId,
          })
          .execute();
        await audit.record(
          {
            actorKind: 'USER',
            actorId: customerId,
            action: 'booking.created',
            entityKind: 'booking',
            entityId: id,
            metadata: { status },
            requestId,
          },
          trx,
        );
        return { bookingId: id, replayed: false };
      });
    } catch (error) {
      // Same key raced in parallel: the unique (customer, key) constraint decides; return the winner (BR-09).
      if ((error as { constraint?: string }).constraint === 'bookings_customer_id_idempotency_key_key') {
        const winner = await db
          .selectFrom('booking.bookings')
          .select(['id', 'quote_id'])
          .where('customer_id', '=', customerId)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirstOrThrow();
        if (winner.quote_id !== input.quoteId) throw bookingErrors.idempotencyConflict();
        return { bookingId: winner.id, replayed: true };
      }
      if ((error as { constraint?: string }).constraint === 'bookings_quote_id_key')
        throw bookingErrors.quoteExpired();
      throw error;
    }
  }

  // ------------------------------------------------------------------ transitions

  async function transition(
    bookingId: string,
    action: BookingAction,
    actor: Actor,
    options: {
      requestId: string;
      reason?: string | undefined;
      guard: (row: { customer_id: string; host_account_id: string }) => boolean;
      /** Effective statuses this actor may not apply the action from, even if the lifecycle allows it. */
      notFrom?: BookingStatus[];
      /** Extra columns, computed from the locked row (so a concurrent payment can't skew a refund). */
      extra?: (row: BookingRow) => Record<string, unknown>;
      /** Runs after the locks, before the change (may refuse). */
      check?: (trx: Transaction<BookingDb>, row: BookingRow) => Promise<void>;
      /** Runs in the same transaction after the change (series bookkeeping). */
      after?: (trx: Transaction<BookingDb>, row: BookingRow) => Promise<void>;
    },
  ) {
    return db.transaction().execute(async (trx) => {
      await lockSeriesOf(trx, bookingId);
      const row = await trx
        .selectFrom('booking.bookings as b')
        .selectAll('b')
        .select([
          notLapsed.as('live'),
          sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        ])
        .where('b.id', '=', bookingId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || !options.guard(row)) throw errors.notFound();
      const current = effectiveStatus(row.status as BookingStatus, row.live);
      const to = options.notFrom?.includes(current) ? null : nextStatus(current, action);
      if (!to) throw bookingErrors.transitionNotAllowed(current);
      if (options.check) await options.check(trx, row);
      await trx
        .updateTable('booking.bookings')
        .set({ status: to, version: sql<number>`version + 1`, ...(options.extra ? options.extra(row) : {}) })
        .where('id', '=', bookingId)
        .execute();
      await trx
        .insertInto('booking.booking_events')
        .values({
          booking_id: bookingId,
          from_status: row.status,
          to_status: to,
          actor_kind: actor.kind,
          actor_id: actor.userId,
          reason: options.reason ?? action,
          request_id: options.requestId,
        })
        .execute();
      await lifecycle(trx, bookingId, to, options.requestId);
      if (options.after) await options.after(trx, row);
      return { row, to };
    });
  }

  /** Customer or host cancellation with the refund computed from the booking's policy snapshot (BR-21, BR-22). */
  async function cancel(
    bookingId: string,
    by: Canceller,
    actor: Actor,
    guard: (row: { customer_id: string; host_account_id: string }) => boolean,
    reason: string | undefined,
    requestId: string,
  ) {
    let refund = { refundPaise: 0, refundBps: 0 };
    await transition(bookingId, 'CANCEL', actor, {
      requestId,
      reason: reason ?? `cancelled by ${by.toLowerCase()}`,
      guard,
      // Once the customer is in, cancelling is a dispute, not a self-service action (BR-21).
      ...(by === 'CUSTOMER' ? { notFrom: ['IN_PROGRESS' as const] } : {}),
      extra: (row) => {
        const paid = row.status === 'CONFIRMED' || row.status === 'IN_PROGRESS' ? Number(row.total_paise) : 0;
        refund = refundFor({
          policy: row.policy_snapshot as PolicySnapshot,
          paidPaise: paid,
          startMs: Number(row.start_ms),
          cancelledAtMs: now(),
          by,
        });
        return { cancelled_by: by, cancel_reason: reason ?? null, refund_paise: refund.refundPaise };
      },
      check: async (trx, row) => {
        if (row.series_id && by === 'CUSTOMER') await series.assertCustomerMayCancel(trx, row.series_id);
      },
      after: async (trx, row) => {
        if (refund.refundPaise > 0) {
          const cause =
            by === 'HOST'
              ? 'HOST_CANCELLED'
              : by === 'PLATFORM'
                ? 'PLATFORM_CANCELLED'
                : 'CUSTOMER_CANCELLED';
          await events.publish(
            'booking.refund_due',
            { bookingId, amountPaise: refund.refundPaise, cause, requestId },
            trx,
          );
        }
        if (row.series_id)
          await series.onPeriodCancelled(trx, row.series_id, Number(row.start_ms), by, actor, requestId);
      },
    });
    await audit.record({
      actorKind: actor.kind === 'SYSTEM' ? 'SYSTEM' : by === 'PLATFORM' ? 'ADMIN' : 'USER',
      actorId: actor.userId,
      action: by === 'HOST' ? 'booking.cancelled_by_host' : 'booking.cancelled',
      entityKind: 'booking',
      entityId: bookingId,
      metadata: { refundPaise: refund.refundPaise, refundBps: refund.refundBps },
      requestId,
    });
    // Money movement (refund to the payment method) is Phase 15; the amount is fixed here.
    return refund;
  }

  /**
   * PAYMENT_SUCCEEDED (internal; called only by the payments module on a verified provider event, Phase 15 / BR-15).
   * Late success after the hold lapsed: reconfirm if the unit is still free, else the caller refunds.
   */
  async function confirmPayment(bookingId: string, requestId: string): Promise<{ confirmed: boolean }> {
    return db.transaction().execute(async (trx) => {
      await lockSeriesOf(trx, bookingId);
      const row = await trx
        .selectFrom('booking.bookings as b')
        .selectAll()
        .select(notLapsed.as('live'))
        .where('b.id', '=', bookingId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound();
      if (row.status === 'CONFIRMED') return { confirmed: true }; // idempotent
      const reviving = row.status === 'EXPIRED' || (row.status === 'PENDING_PAYMENT' && !row.live);
      if (row.status !== 'PENDING_PAYMENT' && row.status !== 'EXPIRED') return { confirmed: false };
      if (reviving) {
        try {
          await sql`SAVEPOINT revive`.execute(trx);
          await trx
            .updateTable('booking.bookings')
            .set({ status: 'CONFIRMED', hold_expires_at: null })
            .where('id', '=', bookingId)
            .execute();
          await sql`RELEASE SAVEPOINT revive`.execute(trx);
        } catch (error) {
          await sql`ROLLBACK TO SAVEPOINT revive`.execute(trx);
          if ((error as { constraint?: string }).constraint === 'bookings_no_overlap')
            return { confirmed: false };
          throw error;
        }
      } else {
        await trx
          .updateTable('booking.bookings')
          .set({ status: 'CONFIRMED' })
          .where('id', '=', bookingId)
          .execute();
      }
      await trx
        .insertInto('booking.booking_events')
        .values({
          booking_id: bookingId,
          from_status: row.status,
          to_status: 'CONFIRMED',
          actor_kind: 'SYSTEM',
          actor_id: null,
          reason: reviving ? 'late payment, unit still free' : 'payment succeeded',
          request_id: requestId,
        })
        .execute();
      await lifecycle(trx, bookingId, 'CONFIRMED', requestId);
      if (row.series_id) await series.onPeriodConfirmed(trx, row.series_id, row.period_index ?? 1, requestId);
      return { confirmed: true };
    });
  }

  // ------------------------------------------------------------------ reads

  async function customerBooking(customerId: string, bookingId: string) {
    const row = await db
      .selectFrom('booking.bookings as b')
      .selectAll('b')
      .select([
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.id', '=', bookingId)
      .where('b.customer_id', '=', customerId)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const ctx = await deps.assets.bookingContext(row.asset_id);
    const vehicle = await deps.users.vehicleById(row.vehicle_id);
    const status = effectiveStatus(row.status as BookingStatus, row.live);
    const start = Number(row.start_ms);
    const end = Number(row.end_ms);
    // L-6: exact address, entrance, space label and instructions only for a confirmed booking until end + 24 h.
    const revealed =
      (status === 'CONFIRMED' || status === 'IN_PROGRESS') && now() < end + REVEAL_AFTER_END_MS;
    const access = revealed ? await deps.assets.revealAccess(row.asset_id, row.unit_id) : null;
    const address = revealed ? await deps.properties.exactAddress(row.property_id) : null;
    const snapshot = row.price_snapshot as { lines: QuoteLine[]; totalPaise: number };
    const paid = status === 'CONFIRMED' || status === 'IN_PROGRESS' ? Number(row.total_paise) : 0;
    const seriesStatus = row.series_id
      ? (
          await db
            .selectFrom('booking.booking_series')
            .select('status')
            .where('id', '=', row.series_id)
            .executeTakeFirst()
        )?.status
      : null;
    // A running monthly plan ends by notice, not by cancelling one of its periods (D-104).
    const cancellable =
      ['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'].includes(status) &&
      (!row.series_id || seriesStatus === 'REQUESTED');
    return {
      id: row.id,
      status,
      listing: {
        id: row.asset_id,
        title: ctx?.title ?? 'Listing',
        type: row.asset_type as 'PARKING' | 'EV_CHARGING',
      },
      mode: row.mode as BookingMode,
      start: new Date(start),
      end: new Date(end),
      vehicle: vehicle ? { plate: formatPlate(vehicle.plate), vehicleClass: vehicle.vehicleClass } : null,
      price: { lines: snapshot.lines, totalPaise: Number(row.total_paise) },
      holdExpiresAt: status === 'PENDING_PAYMENT' ? row.hold_expires_at : null,
      approvalExpiresAt: status === 'AWAITING_HOST_APPROVAL' ? row.approval_expires_at : null,
      cancellation: {
        policy: row.policy_snapshot as PolicySnapshot,
        cancellable,
        refundIfCancelledNowPaise: cancellable
          ? refundFor({
              policy: row.policy_snapshot as PolicySnapshot,
              paidPaise: paid,
              startMs: start,
              cancelledAtMs: now(),
              by: 'CUSTOMER',
            }).refundPaise
          : null,
        cancelledBy: row.cancelled_by as Canceller | null,
        refundPaise: row.refund_paise === null ? null : Number(row.refund_paise),
      },
      access: revealed
        ? { address, unitLabel: access?.unitLabel ?? null, instructions: access?.accessInstructions ?? null }
        : null,
      series: row.series_id ? { id: row.series_id, periodIndex: row.period_index ?? 1 } : null,
      issue: await issues.latestFor(row.id),
      createdAt: row.created_at,
    };
  }

  async function customerBookings(customerId: string) {
    const rows = await db
      .selectFrom('booking.bookings')
      .select('id')
      .where('customer_id', '=', customerId)
      .orderBy(sql`lower(period)`, 'desc')
      .limit(100)
      .execute();
    return Promise.all(rows.map((r) => customerBooking(customerId, r.id)));
  }

  async function hostBooking(hostAccountId: string, bookingId: string) {
    const row = await db
      .selectFrom('booking.bookings as b')
      .selectAll('b')
      .select([
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.id', '=', bookingId)
      .where('b.host_account_id', '=', hostAccountId)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const status = effectiveStatus(row.status as BookingStatus, row.live);
    const [ctx, vehicle, customerName, unitLabel] = await Promise.all([
      deps.assets.bookingContext(row.asset_id),
      deps.users.vehicleById(row.vehicle_id),
      deps.identity.customerNameForHost(row.customer_id),
      deps.assets.unitLabel(row.unit_id),
    ]);
    const end = Number(row.end_ms);
    // trust-and-safety §11: hosts see the plate during the booking; masked 30 days after it ends.
    const showPlate = now() < end + 30 * 86_400_000;
    return {
      id: row.id,
      status,
      listing: { id: row.asset_id, title: ctx?.title ?? 'Listing' },
      unitLabel,
      mode: row.mode as BookingMode,
      start: new Date(Number(row.start_ms)),
      end: new Date(end),
      customer: { name: customerName },
      vehicle: vehicle
        ? {
            plate: showPlate ? formatPlate(vehicle.plate) : `•••• ${vehicle.plate.slice(-4)}`,
            vehicleClass: vehicle.vehicleClass,
            isEv: vehicle.isEv,
          }
        : null,
      totalPaise: Number(row.total_paise),
      approvalExpiresAt: status === 'AWAITING_HOST_APPROVAL' ? row.approval_expires_at : null,
      cancelledBy: row.cancelled_by as Canceller | null,
      series: row.series_id ? { id: row.series_id, periodIndex: row.period_index ?? 1 } : null,
      issue: await issues.latestFor(row.id),
      // BR-26 (D-139): the host may report a no-show 30 minutes after the start if the customer never checked in.
      canReportNoShow:
        row.status === 'CONFIRMED' &&
        row.mode !== 'MONTHLY' &&
        now() >= Number(row.start_ms) + NO_SHOW_GRACE_MINUTES * 60_000 &&
        now() < end &&
        !(await issues.hasOpenIssue(row.id)),
      createdAt: row.created_at,
    };
  }

  async function hostBookings(hostAccountId: string) {
    const rows = await db
      .selectFrom('booking.bookings')
      .select('id')
      .where('host_account_id', '=', hostAccountId)
      .orderBy(sql`lower(period)`, 'desc')
      .limit(200)
      .execute();
    return Promise.all(rows.map((r) => hostBooking(hostAccountId, r.id)));
  }

  /**
   * Price facts and timing for the ledger (Phase 16). Runs on the caller's transaction when given (it is called from
   * inside payment transactions, D-096).
   */
  async function earningsContext(bookingId: string, executor?: AnyKyselyExecutor) {
    const x = (executor as unknown as Kysely<BookingDb> | undefined) ?? db;
    const row = await x
      .selectFrom('booking.bookings as b')
      .select([
        'b.id',
        'b.host_account_id',
        'b.status',
        'b.total_paise',
        'b.price_snapshot',
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    if (!row) return null;
    const snap = row.price_snapshot as {
      lines?: QuoteLine[];
      basePaise?: number;
      serviceFeePaise?: number;
      hostCommissionBps?: number;
    };
    const total = Number(row.total_paise);
    // Older snapshots carry only lines: derive the parts from them (the commission rate then from the config).
    const fee =
      snap.serviceFeePaise ??
      (snap.lines ?? []).filter((l) => l.kind === 'SERVICE_FEE').reduce((a, l) => a + l.amountPaise, 0);
    return {
      bookingId: row.id,
      hostAccountId: row.host_account_id,
      status: effectiveStatus(row.status as BookingStatus, row.live),
      totalPaise: total,
      basePaise: snap.basePaise ?? total - fee,
      serviceFeePaise: fee,
      commissionBps: snap.hostCommissionBps ?? PRICING_CONFIG.hostCommissionBps,
      end: Number(row.end_ms),
    };
  }

  /** What the payments module needs to take a payment for a booking (it never changes booking state itself). */
  async function paymentContext(bookingId: string) {
    const row = await db
      .selectFrom('booking.bookings as b')
      .select([
        'b.id',
        'b.customer_id',
        'b.status',
        'b.total_paise',
        'b.hold_expires_at',
        notLapsed.as('live'),
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      bookingId: row.id,
      customerId: row.customer_id,
      status: effectiveStatus(row.status as BookingStatus, row.live),
      totalPaise: Number(row.total_paise),
      holdExpiresAt: row.hold_expires_at,
    };
  }

  /** Who and when, for notifications (on the caller's transaction when given). */
  async function partiesOf(bookingId: string, executor?: AnyKyselyExecutor) {
    const x = (executor as unknown as Kysely<BookingDb> | undefined) ?? db;
    const r = await x
      .selectFrom('booking.bookings')
      .select([
        'id',
        'customer_id',
        'host_account_id',
        'asset_id',
        'status',
        'total_paise',
        'refund_paise',
        'created_at',
        sql<number>`extract(epoch FROM lower(period)) * 1000`.as('s'),
        sql<number>`extract(epoch FROM upper(period)) * 1000`.as('e'),
      ])
      .where('id', '=', bookingId)
      .executeTakeFirst();
    return r
      ? {
          bookingId: r.id,
          customerId: r.customer_id,
          hostAccountId: r.host_account_id,
          assetId: r.asset_id,
          status: r.status,
          totalPaise: Number(r.total_paise),
          refundPaise: r.refund_paise === null ? null : Number(r.refund_paise),
          createdAt: r.created_at,
          start: Number(r.s),
          end: Number(r.e),
        }
      : null;
  }

  /** Admin list (Phase 20): filters and pagination over bookings. */
  async function adminList(f: {
    status?: string | undefined;
    q?: string | undefined;
    hostAccountId?: string | undefined;
    customerId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('booking.bookings as b');
    if (f.status) q = q.where('b.status', '=', f.status);
    if (f.q && /^[0-9a-f-]{8,36}$/i.test(f.q))
      q = q.where(sql<boolean>`b.id::text LIKE ${`${f.q.toLowerCase()}%`}`);
    if (f.hostAccountId) q = q.where('b.host_account_id', '=', f.hostAccountId);
    if (f.customerId) q = q.where('b.customer_id', '=', f.customerId);
    if (f.from) q = q.where(sql<boolean>`upper(b.period) > ${f.from}`);
    if (f.to) q = q.where(sql<boolean>`lower(b.period) < ${f.to}`);
    const [rows, total] = await Promise.all([
      q
        .select([
          'b.id',
          'b.status',
          'b.mode',
          'b.asset_type',
          'b.asset_id',
          'b.customer_id',
          'b.host_account_id',
          'b.total_paise',
          'b.created_at',
          sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('s'),
          sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('e'),
        ])
        .orderBy('b.created_at', 'desc')
        .offset(f.offset)
        .limit(f.limit)
        .execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        mode: r.mode,
        assetType: r.asset_type,
        assetId: r.asset_id,
        customerId: r.customer_id,
        hostAccountId: r.host_account_id,
        totalPaise: Number(r.total_paise),
        start: new Date(Number(r.s)),
        end: new Date(Number(r.e)),
        createdAt: r.created_at,
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  async function adminView(bookingId: string) {
    const row = await db
      .selectFrom('booking.bookings')
      .select(['host_account_id', 'customer_id'])
      .where('id', '=', bookingId)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const [host, events] = await Promise.all([
      hostBooking(row.host_account_id, bookingId),
      eventsOf(bookingId),
    ]);
    return { ...host, customerId: row.customer_id, hostAccountId: row.host_account_id, events };
  }

  /** Platform cancellation (support): full refund through the refund pipeline; reason recorded. */
  async function cancelByPlatform(adminId: string, bookingId: string, reason: string, requestId: string) {
    return cancel(
      bookingId,
      'PLATFORM',
      { kind: 'PLATFORM_ADMIN', userId: adminId },
      () => true,
      reason,
      requestId,
    );
  }

  /** Fraud indicators from booking history (A-04): repeat no-shows and unreliable hosts (90 days). */
  async function riskSignals() {
    const [noShows, hostCancels] = await Promise.all([
      db
        .selectFrom('booking.bookings')
        .select(['customer_id', sql<string>`count(*)`.as('n')])
        .where('status', '=', 'NO_SHOW')
        .where(sql<boolean>`updated_at > now() - interval '90 days'`)
        .groupBy('customer_id')
        .having(sql<boolean>`count(*) >= 2`)
        .execute(),
      db
        .selectFrom('booking.bookings')
        .select(['host_account_id', sql<string>`count(*)`.as('n')])
        .where('status', '=', 'CANCELLED')
        .where('cancelled_by', '=', 'HOST')
        .where(sql<boolean>`updated_at > now() - interval '90 days'`)
        .groupBy('host_account_id')
        .having(sql<boolean>`count(*) >= 2`)
        .execute(),
    ]);
    return [
      ...noShows.map((r) => ({
        kind: 'REPEAT_NO_SHOW',
        subject: { kind: 'user', id: r.customer_id },
        count: Number(r.n),
        detail: `${r.n} no-shows in 90 days`,
      })),
      ...hostCancels.map((r) => ({
        kind: 'HOST_CANCELLATIONS',
        subject: { kind: 'host_account', id: r.host_account_id },
        count: Number(r.n),
        detail: `${r.n} host cancellations in 90 days`,
      })),
    ];
  }

  /** Booking history for dispute evidence (admin only). */
  async function eventsOf(bookingId: string) {
    const rows = await db
      .selectFrom('booking.booking_events')
      .select(['from_status', 'to_status', 'actor_kind', 'reason', 'created_at'])
      .where('booking_id', '=', bookingId)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      from: r.from_status,
      to: r.to_status,
      actor: r.actor_kind,
      reason: r.reason,
      at: r.created_at,
    }));
  }

  /** Trust signals (trust-and-safety §8): a customer's track record. */
  async function customerStats(customerId: string) {
    const r = await db
      .selectFrom('booking.bookings')
      .select([
        sql<string>`count(*) FILTER (WHERE status = 'COMPLETED')`.as('completed'),
        sql<string>`count(*) FILTER (WHERE status = 'NO_SHOW')`.as('no_shows'),
        sql<string>`count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_by = 'CUSTOMER' AND created_at > now() - interval '90 days')`.as(
          'cancelled',
        ),
      ])
      .where('customer_id', '=', customerId)
      .executeTakeFirstOrThrow();
    return { completed: Number(r.completed), noShows: Number(r.no_shows), cancelled90d: Number(r.cancelled) };
  }

  /** Trust signals: a host's reliability over the last 90 days (host cancellations of confirmed bookings). */
  async function hostStats(hostAccountId: string) {
    const r = await db
      .selectFrom('booking.bookings')
      .select([
        sql<string>`count(*) FILTER (WHERE status = 'COMPLETED')`.as('completed'),
        sql<string>`count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_by = 'HOST' AND refund_paise > 0 AND updated_at > now() - interval '90 days')`.as(
          'host_cancelled',
        ),
      ])
      .where('host_account_id', '=', hostAccountId)
      .executeTakeFirstOrThrow();
    return { completed: Number(r.completed), hostCancellations90d: Number(r.host_cancelled) };
  }

  /** Confirmed bookings around now, for reminder / start / ending-soon notifications. */
  async function scheduleFeed() {
    const rows = await db
      .selectFrom('booking.bookings')
      .select([
        'id',
        sql<number>`extract(epoch FROM lower(period)) * 1000`.as('s'),
        sql<number>`extract(epoch FROM upper(period)) * 1000`.as('e'),
        'created_at',
      ])
      .where('status', 'in', ['CONFIRMED', 'IN_PROGRESS'])
      .where(
        sql<boolean>`(lower(period) BETWEEN now() - interval '15 minutes' AND now() + interval '65 minutes') OR (upper(period) BETWEEN now() AND now() + interval '20 minutes')`,
      )
      .limit(2000)
      .execute();
    return rows.map((r) => ({
      bookingId: r.id,
      start: Number(r.s),
      end: Number(r.e),
      createdAt: r.created_at,
    }));
  }

  /** Minimal booking facts for the charging module (EV sessions are bounded by the booking, BR-28). */
  async function chargingContext(bookingId: string) {
    const row = await db
      .selectFrom('booking.bookings as b')
      .select([
        'b.id',
        'b.customer_id',
        'b.host_account_id',
        'b.asset_id',
        'b.asset_type',
        'b.status',
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      bookingId: row.id,
      customerId: row.customer_id,
      hostAccountId: row.host_account_id,
      assetId: row.asset_id,
      assetType: row.asset_type as 'PARKING' | 'EV_CHARGING',
      status: effectiveStatus(row.status as BookingStatus, row.live),
      start: Number(row.start_ms),
      end: Number(row.end_ms),
    };
  }

  // ------------------------------------------------------------------ recourse, check-in, no-show (Phase 17)

  const issues = createIssueService({
    db,
    audit,
    now,
    opened: (e) => events.publish('booking.issue_opened', e, db),
    refundByPlatform: (bookingId, reason, requestId) =>
      cancel(
        bookingId,
        'PLATFORM',
        { kind: 'SYSTEM', userId: null },
        () => true,
        reason.slice(0, 300),
        requestId,
      ),
  });

  /** CHECK_IN (CONFIRMED → IN_PROGRESS): a verified entry or the customer's "I'm here" (the access module decides). */
  async function checkIn(bookingId: string, source: 'CUSTOMER' | 'GUARD' | 'ADAPTER', requestId: string) {
    const r = await db
      .selectFrom('booking.bookings')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirst();
    if (r?.status !== 'CONFIRMED') return { checkedIn: r?.status === 'IN_PROGRESS' };
    await transition(
      bookingId,
      'CHECK_IN',
      { kind: 'SYSTEM', userId: null },
      { requestId, reason: `check-in (${source.toLowerCase()})`, guard: () => true },
    );
    return { checkedIn: true };
  }

  async function reportNoShow(
    host: { hostAccountId: string; userId: string },
    bookingId: string,
    requestId: string,
  ) {
    await transition(
      bookingId,
      'NO_SHOW',
      { kind: 'HOST', userId: host.userId },
      {
        requestId,
        reason: 'customer did not arrive (host report)',
        guard: (r) => r.host_account_id === host.hostAccountId,
        check: async (_trx, row) => {
          const tooEarly = now() < Number(row.start_ms) + NO_SHOW_GRACE_MINUTES * 60_000;
          const open = await issues.hasOpenIssue(bookingId);
          // An open issue suspends no-show (the customer may be stuck at the gate, BR-26); monthly plans never no-show.
          if (tooEarly || open || row.mode === 'MONTHLY')
            throw bookingErrors.transitionNotAllowed('CONFIRMED');
        },
        extra: () => ({ refund_paise: 0 }),
      },
    );
    await audit.record({
      actorKind: 'USER',
      actorId: host.userId,
      action: 'booking.no_show_reported',
      entityKind: 'booking',
      entityId: bookingId,
      requestId,
    });
  }

  // ------------------------------------------------------------------ jobs (architecture §7)

  /** expire-holds / expire-approvals: tidy lapsed holds (queries already ignore them, D-036). */
  async function expireLapsedHolds(): Promise<number> {
    return db.transaction().execute(async (trx) => {
      // SKIP LOCKED: a booking transaction already handling a row wins; the next tick catches anything left.
      const rows = await lapsedHolds(trx).limit(500).forUpdate().skipLocked().execute();
      return systemTransition(trx, rows, 'EXPIRED', 'hold lapsed', 'job:expire-holds');
    });
  }

  /**
   * booking-transitions: bookings past their end become COMPLETED. NO_SHOW detection needs check-in / access events
   * (BR-26, Phase 17); until then a confirmed booking is assumed used (the customer-favourable default).
   */
  async function completeFinished(): Promise<number> {
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('booking.bookings')
        .select(['id', 'status'])
        .where('status', 'in', ['CONFIRMED', 'IN_PROGRESS'])
        .where(sql<boolean>`upper(period) <= now()`)
        .limit(500)
        .forUpdate()
        .skipLocked()
        .execute();
      return systemTransition(trx, rows, 'COMPLETED', 'ended', 'job:booking-transitions');
    });
  }

  return {
    quote,
    createBooking,
    customerBooking,
    customerBookings,
    hostBooking,
    hostBookings,
    cancelByCustomer: (
      customerId: string,
      bookingId: string,
      reason: string | undefined,
      requestId: string,
    ) =>
      cancel(
        bookingId,
        'CUSTOMER',
        { kind: 'CUSTOMER', userId: customerId },
        (r) => r.customer_id === customerId,
        reason,
        requestId,
      ),
    cancelByHost: (
      host: { hostAccountId: string; userId: string },
      bookingId: string,
      reason: string,
      requestId: string,
    ) =>
      cancel(
        bookingId,
        'HOST',
        { kind: 'HOST', userId: host.userId },
        (r) => r.host_account_id === host.hostAccountId,
        reason,
        requestId,
      ),
    approveByHost: (host: { hostAccountId: string; userId: string }, bookingId: string, requestId: string) =>
      transition(
        bookingId,
        'HOST_APPROVE',
        { kind: 'HOST', userId: host.userId },
        {
          requestId,
          guard: (r) => r.host_account_id === host.hostAccountId,
          extra: () => ({ hold_expires_at: sql<Date>`now() + make_interval(mins => ${HOLD_MINUTES})` }),
          after: (trx) => events.publish('booking.approved', { bookingId, requestId }, trx),
        },
      ),
    declineByHost: (
      host: { hostAccountId: string; userId: string },
      bookingId: string,
      reason: string | undefined,
      requestId: string,
    ) =>
      transition(
        bookingId,
        'HOST_DECLINE',
        { kind: 'HOST', userId: host.userId },
        {
          requestId,
          reason,
          guard: (r) => r.host_account_id === host.hostAccountId,
          after: async (trx, row) => {
            if (row.series_id) await series.onFirstPeriodFailed(trx, row.series_id, requestId);
          },
        },
      ),
    confirmPayment,
    partiesOf,
    scheduleFeed,
    adminList,
    adminView,
    cancelByPlatform,
    riskSignals,
    eventsOf,
    customerStats,
    hostStats,
    paymentContext,
    earningsContext,
    chargingContext,
    expireLapsedHolds,
    completeFinished,
    reservations,
    checkIn,
    reportNoShow,
    issues: {
      openByCustomer: (
        customerId: string,
        bookingId: string,
        kind: IssueKind,
        note: string | null,
        requestId: string,
      ) => issues.open(bookingId, { kind, note, reporter: 'CUSTOMER', customerId }, requestId),
      openBySystem: (bookingId: string, kind: IssueKind, note: string | null, requestId: string) =>
        issues.open(bookingId, { kind, note, reporter: 'SYSTEM' }, requestId),
      hostRespond: issues.hostRespond,
      customerRespond: issues.customerRespond,
      autoResolve: issues.autoResolve,
    },
    series: {
      listForCustomer: (customerId: string) => series.listFor({ kind: 'CUSTOMER', customerId }),
      getForCustomer: (customerId: string, seriesId: string) =>
        series.getFor({ kind: 'CUSTOMER', customerId }, seriesId),
      listForHost: (hostAccountId: string, userId: string) =>
        series.listFor({ kind: 'HOST', hostAccountId, userId }),
      getForHost: (hostAccountId: string, userId: string, seriesId: string) =>
        series.getFor({ kind: 'HOST', hostAccountId, userId }, seriesId),
      noticeByCustomer: (customerId: string, seriesId: string, requestId: string) =>
        series.giveNotice(seriesId, { kind: 'CUSTOMER', customerId }, requestId),
      noticeByHost: (host: { hostAccountId: string; userId: string }, seriesId: string, requestId: string) =>
        series.giveNotice(
          seriesId,
          { kind: 'HOST', hostAccountId: host.hostAccountId, userId: host.userId },
          requestId,
        ),
      tick: series.tick,
    },
  };
}

/** A lapsed hold reads as EXPIRED immediately, even before the job has persisted it (D-036). */
function effectiveStatus(status: BookingStatus, live: boolean): BookingStatus {
  return (status === 'PENDING_PAYMENT' || status === 'AWAITING_HOST_APPROVAL') && !live ? 'EXPIRED' : status;
}

export type BookingService = ReturnType<typeof createBookingService>;
