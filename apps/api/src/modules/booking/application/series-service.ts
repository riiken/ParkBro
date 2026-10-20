import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { AssetsModule, BookingContext } from '../../assets/index.ts';
import type { UnavailableReason } from '../../availability/index.ts';
import type { IdentityModule } from '../../identity/index.ts';
import type { BookingMode, QuoteLine } from '../../pricing/index.ts';
import type { PropertiesModule } from '../../properties/index.ts';
import { formatPlate, type UsersModule } from '../../users/index.ts';
import type { Canceller, PolicySnapshot } from '../domain/cancellation.ts';
import {
  nextSeriesStatus,
  noticeEnd,
  periodAt,
  periodWindow,
  type SeriesAction,
  type SeriesCadence,
  type SeriesEndReason,
  type SeriesStatus,
} from '../domain/series.ts';
import type { BookingStatus } from '../domain/state-machine.ts';
import type { BookingDb, SeriesTable } from '../infrastructure/tables.ts';
import { notLapsed } from './reservations.ts';

type SeriesRow = Selectable<SeriesTable>;
type Actor = { kind: 'CUSTOMER' | 'HOST' | 'PLATFORM_ADMIN' | 'SYSTEM'; userId: string | null };
type Party =
  { kind: 'CUSTOMER'; customerId: string } | { kind: 'HOST'; hostAccountId: string; userId: string };

export const seriesErrors = {
  useNotice: () =>
    new DomainError({
      code: 'booking.series_use_notice',
      status: 409,
      title: 'This is part of a monthly plan',
      detail: 'Give notice on the plan instead. It ends at the end of a monthly period.',
    }),
  transitionNotAllowed: (from: string) =>
    new DomainError({
      code: 'series.transition_not_allowed',
      status: 409,
      title: 'That action is not available for this plan',
      detail: `The plan is ${from.toLowerCase().replaceAll('_', ' ')}.`,
    }),
};

/** What the series needs from the booking engine (shared, so renewals obey exactly the same rules). */
export interface BookingKernel {
  db: Kysely<BookingDb>;
  audit: AuditLog;
  now: () => number;
  assets: AssetsModule;
  properties: PropertiesModule;
  identity: IdentityModule;
  users: UsersModule;
  evaluate(
    ctx: BookingContext,
    timezone: string,
    start: number,
    end: number,
    mode: BookingMode,
    executor: Transaction<BookingDb>,
  ): Promise<
    { ok: true; unitIds: string[] } | { ok: false; reason: UnavailableReason | 'LEAD_TIME' | 'DURATION' }
  >;
  expireLapsedOn(
    trx: Transaction<BookingDb>,
    unitIds: string[],
    start: number,
    end: number,
    requestId: string,
  ): Promise<void>;
  capAllows(
    trx: Transaction<BookingDb>,
    propertyId: string,
    cap: number | null,
    start: number,
    end: number,
  ): Promise<boolean>;
  /** The booking was cancelled by the series (access revocation). */
  closed(trx: Transaction<BookingDb>, bookingId: string, requestId: string): Promise<void>;
  refundDue(
    trx: Transaction<BookingDb>,
    bookingId: string,
    amountPaise: number,
    cause: 'HOST_CANCELLED' | 'SERIES_ENDED',
    requestId: string,
  ): Promise<void>;
}

const toSeries = (row: SeriesRow) => ({
  cadence: row.cadence as SeriesCadence,
  anchorStart: row.anchor_start.getTime(),
  timezone: row.timezone,
  noticeDays: row.notice_days,
});

/**
 * Monthly arrangements (domain-model §5.4, D-014, D-104). Every period is an ordinary booking on the same unit; the
 * series only decides when the next period is created, when it is overdue, and when the arrangement ends.
 */
export function createSeriesService(k: BookingKernel) {
  const { db, audit, now } = k;

  async function lockSeries(trx: Transaction<BookingDb>, seriesId: string) {
    return trx
      .selectFrom('booking.booking_series')
      .selectAll()
      .where('id', '=', seriesId)
      .forUpdate()
      .executeTakeFirst();
  }

  async function move(
    trx: Transaction<BookingDb>,
    series: SeriesRow,
    action: SeriesAction,
    actor: Actor,
    requestId: string,
    extra: { reason?: string; endedReason?: SeriesEndReason; endsAt?: number; noticeBy?: Canceller } = {},
  ): Promise<SeriesStatus | null> {
    const to = nextSeriesStatus(series.status as SeriesStatus, action);
    if (!to) return null;
    await trx
      .updateTable('booking.booking_series')
      .set({
        status: to,
        version: sql<number>`version + 1`,
        ...(extra.endedReason ? { ended_reason: extra.endedReason } : {}),
        ...(extra.endsAt !== undefined ? { ends_at: new Date(extra.endsAt) } : {}),
        ...(extra.noticeBy ? { notice_by: extra.noticeBy, notice_given_at: new Date(now()) } : {}),
      })
      .where('id', '=', series.id)
      .execute();
    if (to !== series.status || action === 'RENEWAL_PAID') {
      await trx
        .insertInto('booking.series_events')
        .values({
          series_id: series.id,
          from_status: series.status,
          to_status: to,
          actor_kind: actor.kind,
          actor_id: actor.userId,
          reason: extra.reason ?? extra.endedReason ?? action,
          request_id: requestId,
        })
        .execute();
    }
    return to;
  }

  /** Cancels holding periods of a series that start at or after `from`, refunding anything paid in full. */
  async function cancelPeriodsFrom(
    trx: Transaction<BookingDb>,
    seriesId: string,
    from: number,
    by: Canceller,
    actor: Actor,
    reason: string,
    requestId: string,
  ) {
    const rows = await trx
      .selectFrom('booking.bookings')
      .select(['id', 'status', 'total_paise'])
      .where('series_id', '=', seriesId)
      .where('status', 'in', ['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'])
      .where(sql<boolean>`lower(period) >= to_timestamp(${from / 1000})`)
      .forUpdate()
      .execute();
    for (const r of rows) {
      const refund = r.status === 'CONFIRMED' ? Number(r.total_paise) : 0;
      await trx
        .updateTable('booking.bookings')
        .set({
          status: 'CANCELLED',
          cancelled_by: by,
          cancel_reason: reason,
          refund_paise: refund,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', r.id)
        .execute();
      await trx
        .insertInto('booking.booking_events')
        .values({
          booking_id: r.id,
          from_status: r.status,
          to_status: 'CANCELLED',
          actor_kind: actor.kind,
          actor_id: actor.userId,
          reason,
          request_id: requestId,
        })
        .execute();
      if (refund > 0)
        await k.refundDue(trx, r.id, refund, by === 'HOST' ? 'HOST_CANCELLED' : 'SERIES_ENDED', requestId);
      await k.closed(trx, r.id, requestId);
    }
  }

  // ---------------------------------------------------------------- hooks called by the booking engine

  /** Period 1 of a new monthly request, inside the create transaction. */
  async function createForFirstPeriod(
    trx: Transaction<BookingDb>,
    input: {
      customerId: string;
      vehicleId: string;
      ctx: BookingContext;
      unitId: string;
      timezone: string;
      start: number;
      snapshot: { lines: QuoteLine[]; totalPaise: number; policy: PolicySnapshot } & Record<string, unknown>;
    },
    requestId: string,
  ): Promise<string> {
    const id = uuidv7();
    await trx
      .insertInto('booking.booking_series')
      .values({
        id,
        customer_id: input.customerId,
        vehicle_id: input.vehicleId,
        asset_id: input.ctx.assetId,
        unit_id: input.unitId,
        host_account_id: input.ctx.hostAccountId,
        property_id: input.ctx.propertyId,
        cadence: 'MONTHLY',
        anchor_start: new Date(input.start),
        timezone: input.timezone,
        status: 'REQUESTED',
        // The whole quote minus the policy (lines, base, service fee, commission rate, config version): every period
        // is priced and split exactly like period 1 (D-105).
        period_price_snapshot: JSON.stringify(
          Object.fromEntries(Object.entries(input.snapshot).filter(([k]) => k !== 'policy')),
        ),
        period_total_paise: input.snapshot.totalPaise,
        policy_snapshot: JSON.stringify(input.snapshot.policy),
      })
      .execute();
    await trx
      .insertInto('booking.series_events')
      .values({
        series_id: id,
        from_status: null,
        to_status: 'REQUESTED',
        actor_kind: 'CUSTOMER',
        actor_id: input.customerId,
        reason: 'requested',
        request_id: requestId,
      })
      .execute();
    return id;
  }

  /** PAYMENT_SUCCEEDED on a period. */
  async function onPeriodConfirmed(
    trx: Transaction<BookingDb>,
    seriesId: string,
    periodIndex: number,
    requestId: string,
  ) {
    const series = await lockSeries(trx, seriesId);
    if (!series) return;
    await move(
      trx,
      series,
      periodIndex === 1 ? 'FIRST_CONFIRMED' : 'RENEWAL_PAID',
      { kind: 'SYSTEM', userId: null },
      requestId,
      {
        reason: `period ${periodIndex} paid`,
      },
    );
  }

  /** Period 1 declined: the request ends. */
  async function onFirstPeriodFailed(trx: Transaction<BookingDb>, seriesId: string, requestId: string) {
    const series = await lockSeries(trx, seriesId);
    if (series)
      await move(trx, series, 'FIRST_FAILED', { kind: 'SYSTEM', userId: null }, requestId, {
        endedReason: 'NOT_CONFIRMED',
      });
  }

  /** Before a cancellation is applied: once a plan is running, customers give notice instead (BR-21, §5.4). */
  async function assertCustomerMayCancel(trx: Transaction<BookingDb>, seriesId: string) {
    const series = await lockSeries(trx, seriesId);
    if (series && series.status !== 'REQUESTED') throw seriesErrors.useNotice();
  }

  /** After a booking of the series was cancelled. A host cancellation ends the arrangement (full refunds). */
  async function onPeriodCancelled(
    trx: Transaction<BookingDb>,
    seriesId: string,
    periodStart: number,
    by: Canceller,
    actor: Actor,
    requestId: string,
  ) {
    const series = await lockSeries(trx, seriesId);
    if (!series || series.status === 'ENDED') return;
    if (series.status === 'REQUESTED') {
      await move(trx, series, 'FIRST_FAILED', actor, requestId, {
        endedReason: by === 'HOST' ? 'HOST_CANCELLED' : 'CUSTOMER_CANCELLED',
      });
      return;
    }
    await cancelPeriodsFrom(trx, seriesId, periodStart, by, actor, 'monthly plan ended', requestId);
    await move(trx, series, 'END', actor, requestId, {
      endedReason: by === 'HOST' ? 'HOST_CANCELLED' : 'PLATFORM',
      endsAt: periodStart,
    });
  }

  // ---------------------------------------------------------------- notice (customer or host)

  async function giveNotice(seriesId: string, party: Party, requestId: string) {
    const by: Canceller = party.kind;
    const actor: Actor =
      party.kind === 'CUSTOMER'
        ? { kind: 'CUSTOMER', userId: party.customerId }
        : { kind: 'HOST', userId: party.userId };
    return db.transaction().execute(async (trx) => {
      const series = await lockSeries(trx, seriesId);
      const mine =
        series &&
        (party.kind === 'CUSTOMER'
          ? series.customer_id === party.customerId
          : series.host_account_id === party.hostAccountId);
      if (!series || !mine) throw errors.notFound();
      if (!nextSeriesStatus(series.status as SeriesStatus, 'NOTICE'))
        throw seriesErrors.transitionNotAllowed(series.status);
      const endsAt = noticeEnd(toSeries(series), now());
      await cancelPeriodsFrom(trx, seriesId, endsAt, by, actor, 'notice given', requestId);
      await move(trx, series, 'NOTICE', actor, requestId, {
        endsAt,
        noticeBy: by,
        reason: `notice by ${by.toLowerCase()}`,
      });
      await audit.record(
        {
          actorKind: 'USER',
          actorId: actor.userId,
          action: 'series.notice_given',
          entityKind: 'booking_series',
          entityId: seriesId,
          metadata: { by, endsAt: new Date(endsAt).toISOString() },
          requestId,
        },
        trx,
      );
      return { endsAt: new Date(endsAt) };
    });
  }

  // ---------------------------------------------------------------- the series job (every 5 minutes)

  /** Creates period n+1 on the same unit when period n starts (D-014: the unit is held ahead of renewal). */
  async function renew(seriesId: string, requestId: string): Promise<'RENEWED' | 'SKIPPED' | 'ENDED'> {
    const preview = await db
      .selectFrom('booking.booking_series')
      .select(['asset_id', 'property_id'])
      .where('id', '=', seriesId)
      .executeTakeFirst();
    if (!preview) return 'SKIPPED';
    const ctxPreview = await k.assets.bookingContext(preview.asset_id);
    if (!ctxPreview) return 'SKIPPED';
    return db.transaction().execute(async (trx) => {
      // Lock order: series → property → asset → bookings (same as booking create after the quote).
      const series = await lockSeries(trx, seriesId);
      if (!series || !['ACTIVE', 'NOTICE_GIVEN'].includes(series.status)) return 'SKIPPED';
      const latest = await trx
        .selectFrom('booking.bookings')
        .select(['period_index', 'status'])
        .where('series_id', '=', seriesId)
        .orderBy('period_index', 'desc')
        .limit(1)
        .executeTakeFirst();
      const n = latest?.period_index ?? 0;
      if (n === 0 || !['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(latest?.status ?? ''))
        return 'SKIPPED';
      const s = toSeries(series);
      const current = periodWindow(s, n);
      if (now() < current.start) return 'SKIPPED';
      const next = periodWindow(s, n + 1);
      if (series.ends_at && next.start >= series.ends_at.getTime()) return 'SKIPPED';

      const property = await k.properties.lockForBooking(series.property_id, trx);
      const ctx = await k.assets.bookingContext(series.asset_id, trx);
      const end = async (reason: string) => {
        await move(trx, series, 'END', { kind: 'SYSTEM', userId: null }, requestId, {
          endedReason: 'UNIT_UNAVAILABLE',
          endsAt: next.start,
          reason,
        });
        return 'ENDED' as const;
      };
      // Existing arrangements survive a pause (no *new* bookings); suspension, archive or a withdrawn society end them.
      if (!property || !ctx || !['PUBLISHED', 'PAUSED'].includes(ctx.status))
        return end('listing unavailable');
      if (!['NOT_REQUIRED', 'PARTICIPATING'].includes(property.participationStatus))
        return end('property not participating');
      // No lead time for an existing arrangement; a late tick (runner down) may even renew a period that already began.
      const unitCtx = {
        ...ctx,
        leadMinutes: Math.min(0, Math.floor((next.start - now()) / 60_000)),
        units: ctx.units.filter((u) => u.id === series.unit_id),
      };
      if (unitCtx.units.length === 0) return end('space removed');
      await k.expireLapsedOn(
        trx,
        [series.unit_id],
        next.start,
        next.end + ctx.bufferMinutes * 60_000,
        requestId,
      );
      const check = await k.evaluate(unitCtx, property.timezone, next.start, next.end, 'MONTHLY', trx);
      if (!check.ok) return end(`space not available (${check.reason.toLowerCase()})`);
      if (!(await k.capAllows(trx, series.property_id, property.outsiderCap, next.start, next.end)))
        return end('property cap reached');

      const price = series.period_price_snapshot as { lines: QuoteLine[]; totalPaise: number };
      const id = uuidv7();
      try {
        await sql`SAVEPOINT renew`.execute(trx);
        await trx
          .insertInto('booking.bookings')
          .values({
            id,
            customer_id: series.customer_id,
            vehicle_id: series.vehicle_id,
            asset_id: series.asset_id,
            unit_id: series.unit_id,
            host_account_id: series.host_account_id,
            property_id: series.property_id,
            asset_type: ctx.assetType,
            mode: 'MONTHLY',
            period: sql`tstzrange(to_timestamp(${next.start / 1000}), to_timestamp(${next.end / 1000}), '[)')`,
            buffer_minutes: ctx.bufferMinutes,
            status: 'PENDING_PAYMENT',
            // Renewal deadline = the period start; the unit stays held through the grace period (§5.4, V12).
            hold_expires_at: new Date(next.start + series.grace_days * 86_400_000),
            approval_expires_at: null,
            quote_id: null,
            series_id: series.id,
            period_index: n + 1,
            price_snapshot: JSON.stringify(price),
            policy_snapshot: JSON.stringify(series.policy_snapshot),
            total_paise: Number(series.period_total_paise),
            idempotency_key: `series-${series.id}-${n + 1}`, // a second renewal of the same period is impossible
          })
          .execute();
        await sql`RELEASE SAVEPOINT renew`.execute(trx);
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT renew`.execute(trx);
        const constraint = (error as { constraint?: string }).constraint;
        if (constraint === 'bookings_series_period_uq') return 'SKIPPED';
        if (constraint === 'bookings_no_overlap') return end('space taken');
        throw error;
      }
      await trx
        .insertInto('booking.booking_events')
        .values({
          booking_id: id,
          from_status: null,
          to_status: 'PENDING_PAYMENT',
          actor_kind: 'SYSTEM',
          actor_id: null,
          reason: `renewal for period ${n + 1}`,
          request_id: requestId,
        })
        .execute();
      return 'RENEWED';
    });
  }

  /** Overdue renewals, lapsed grace, elapsed notice, and requests whose first period never got confirmed. */
  async function settle(seriesId: string, requestId: string) {
    await db.transaction().execute(async (trx) => {
      const series = await lockSeries(trx, seriesId);
      if (!series || series.status === 'ENDED') return;
      const system: Actor = { kind: 'SYSTEM', userId: null };
      const periods = await trx
        .selectFrom('booking.bookings as b')
        .select([
          'b.period_index',
          'b.status',
          notLapsed.as('live'),
          sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        ])
        .where('b.series_id', '=', seriesId)
        .orderBy('b.period_index', 'desc')
        .execute();
      const latest = periods[0];
      if (!latest) return;
      const status = effective(latest.status as BookingStatus, latest.live);

      if (series.status === 'REQUESTED') {
        if (['EXPIRED', 'DECLINED', 'CANCELLED'].includes(status))
          await move(trx, series, 'FIRST_FAILED', system, requestId, { endedReason: 'NOT_CONFIRMED' });
        return;
      }
      if (series.status === 'NOTICE_GIVEN' && series.ends_at && series.ends_at.getTime() <= now()) {
        await move(trx, series, 'END', system, requestId, { endedReason: 'NOTICE' });
        return;
      }
      const renewal = (latest.period_index ?? 0) > 1 ? latest : null;
      if (renewal && status === 'EXPIRED') {
        await move(trx, series, 'END', system, requestId, {
          endedReason: 'RENEWAL_UNPAID',
          endsAt: Number(renewal.start_ms),
        });
        return;
      }
      if (
        series.status === 'ACTIVE' &&
        renewal &&
        status === 'PENDING_PAYMENT' &&
        Number(renewal.start_ms) <= now()
      ) {
        await move(trx, series, 'RENEWAL_OVERDUE', system, requestId, {
          reason: `period ${renewal.period_index} unpaid at start`,
        });
      }
    });
  }

  async function tick(): Promise<number> {
    const open = await db
      .selectFrom('booking.booking_series')
      .select('id')
      .where('status', '<>', 'ENDED')
      .orderBy('updated_at')
      .limit(500)
      .execute();
    let changed = 0;
    for (const { id } of open) {
      await settle(id, 'job:series');
      if ((await renew(id, 'job:series')) !== 'SKIPPED') changed += 1;
    }
    return changed;
  }

  // ---------------------------------------------------------------- reads

  async function view(series: SeriesRow, as: 'CUSTOMER' | 'HOST') {
    const periods = await db
      .selectFrom('booking.bookings as b')
      .select([
        'b.id',
        'b.period_index',
        'b.status',
        'b.total_paise',
        'b.hold_expires_at',
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.series_id', '=', series.id)
      .orderBy('b.period_index')
      .execute();
    const [ctx, vehicle, unitLabel, customerName] = await Promise.all([
      k.assets.bookingContext(series.asset_id),
      k.users.vehicleById(series.vehicle_id),
      as === 'HOST' ? k.assets.unitLabel(series.unit_id) : Promise.resolve(null),
      as === 'HOST' ? k.identity.customerNameForHost(series.customer_id) : Promise.resolve(null),
    ]);
    const latest = periods.at(-1);
    const latestStatus = latest ? effective(latest.status as BookingStatus, latest.live) : null;
    let status = series.status as SeriesStatus;
    // Reads never lag the job: a request whose first period lapsed or was declined reads as ENDED at once.
    if (status === 'REQUESTED' && latestStatus && ['EXPIRED', 'DECLINED', 'CANCELLED'].includes(latestStatus))
      status = 'ENDED';
    const s = toSeries(series);
    const running = periodAt(s, now());
    const nextRenewal =
      ['ACTIVE', 'PAST_DUE'].includes(status) &&
      !(series.ends_at && periodWindow(s, running + 1).start >= series.ends_at.getTime())
        ? {
            periodIndex: running + 1,
            start: new Date(periodWindow(s, running + 1).start),
            amountPaise: Number(series.period_total_paise),
          }
        : null;
    return {
      id: series.id,
      status,
      endedReason:
        status === 'ENDED' ? ((series.ended_reason as SeriesEndReason | null) ?? 'NOT_CONFIRMED') : null,
      cadence: s.cadence,
      listing: { id: series.asset_id, title: ctx?.title ?? 'Listing' },
      vehicle: vehicle ? { plate: formatPlate(vehicle.plate), vehicleClass: vehicle.vehicleClass } : null,
      // Host-only fields; the customer schema strips them from customer responses.
      customer: { name: customerName ?? 'Customer' },
      unitLabel,
      anchorStart: series.anchor_start,
      periodPricePaise: Number(series.period_total_paise),
      noticeDays: series.notice_days,
      graceDays: series.grace_days,
      noticeBy: series.notice_by as Canceller | null,
      endsAt: series.ends_at,
      nextRenewal,
      periods: periods.map((p) => ({
        bookingId: p.id,
        index: p.period_index ?? 0,
        status: effective(p.status as BookingStatus, p.live),
        start: new Date(Number(p.start_ms)),
        end: new Date(Number(p.end_ms)),
        amountPaise: Number(p.total_paise),
        payBy: p.status === 'PENDING_PAYMENT' && p.live ? p.hold_expires_at : null,
      })),
      createdAt: series.created_at,
    };
  }

  async function listFor(party: Party) {
    const rows = await db
      .selectFrom('booking.booking_series')
      .selectAll()
      .where(
        party.kind === 'CUSTOMER' ? 'customer_id' : 'host_account_id',
        '=',
        party.kind === 'CUSTOMER' ? party.customerId : party.hostAccountId,
      )
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return Promise.all(rows.map((r) => view(r, party.kind)));
  }

  async function getFor(party: Party, seriesId: string) {
    const row = await db
      .selectFrom('booking.booking_series')
      .selectAll()
      .where('id', '=', seriesId)
      .where(
        party.kind === 'CUSTOMER' ? 'customer_id' : 'host_account_id',
        '=',
        party.kind === 'CUSTOMER' ? party.customerId : party.hostAccountId,
      )
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    return view(row, party.kind);
  }

  return {
    createForFirstPeriod,
    onPeriodConfirmed,
    onFirstPeriodFailed,
    assertCustomerMayCancel,
    onPeriodCancelled,
    giveNotice,
    renew,
    settle,
    tick,
    listFor,
    getFor,
  };
}

function effective(status: BookingStatus, live: boolean): BookingStatus {
  return (status === 'PENDING_PAYMENT' || status === 'AWAITING_HOST_APPROVAL') && !live ? 'EXPIRED' : status;
}

export type SeriesService = ReturnType<typeof createSeriesService>;
