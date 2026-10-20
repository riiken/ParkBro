import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { AssetsModule } from '../../assets/index.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { ChargerIntegrations, ChargerRef } from '../domain/integration.ts';
import {
  canStartAt,
  maxEnergyKwh,
  nextSessionStatus,
  speedClass,
  START_EARLY_MINUTES,
  type FaultReason,
  type SessionAction,
  type SessionStatus,
} from '../domain/session.ts';
import '../domain/events.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import type { ChargingDb, ChargingSessionsTable } from '../infrastructure/tables.ts';

type Row = Selectable<ChargingSessionsTable>;
type Actor = { kind: 'CUSTOMER' | 'HOST' | 'SYSTEM' | 'INTEGRATION'; userId: string | null };

export const chargingErrors = {
  notCharging: () =>
    new DomainError({
      code: 'charging.not_an_ev_booking',
      status: 409,
      title: 'This booking has no charger',
    }),
  bookingNotActive: () =>
    new DomainError({
      code: 'charging.booking_not_active',
      status: 409,
      title: 'Charging is available only for a confirmed booking',
      detail: 'Your booking needs to be confirmed first.',
    }),
  outsideWindow: () =>
    new DomainError({
      code: 'charging.outside_window',
      status: 409,
      title: 'Outside your booking time',
      detail: `You can start up to ${START_EARLY_MINUTES} minutes before your booking and until it ends.`,
    }),
  transitionNotAllowed: (from: string) =>
    new DomainError({
      code: 'charging.transition_not_allowed',
      status: 409,
      title: 'That action is not available now',
      detail: `The session is ${from.toLowerCase().replaceAll('_', ' ')}.`,
    }),
  chargerRefused: () =>
    new DomainError({
      code: 'charging.charger_refused',
      status: 502,
      title: "The charger didn't start",
      detail: 'Check the plug and try again, or report the charger as not working.',
    }),
};

const HOLDING = ['CONFIRMED', 'IN_PROGRESS'];

/**
 * Charging sessions (Phase 14; domain-model §5.9, BR-28). The booking authorises use of the bay and charger; the
 * session records what happened at the charger through the asset's ChargerIntegration (MANUAL in the pilot). A
 * session never changes booking, payment or access state.
 */
export function createChargingService(deps: {
  db: Kysely<ChargingDb>;
  audit: AuditLog;
  booking: Pick<BookingModule, 'chargingContext' | 'openIssueBySystem'>;
  assets: Pick<AssetsModule, 'chargerProfile'>;
  integrations: ChargerIntegrations;
  events?: DomainEventBus;
  now?: () => number;
}) {
  const { db, audit } = deps;
  const now = deps.now ?? Date.now;

  async function context(bookingId: string, party: { customerId?: string; hostAccountId?: string }) {
    const ctx = await deps.booking.chargingContext(bookingId);
    const mine =
      ctx &&
      (party.customerId ? ctx.customerId === party.customerId : ctx.hostAccountId === party.hostAccountId);
    if (!ctx || !mine) throw errors.notFound();
    if (ctx.assetType !== 'EV_CHARGING') throw chargingErrors.notCharging();
    const charger = await deps.assets.chargerProfile(ctx.assetId);
    if (!charger) throw chargingErrors.notCharging();
    return { ctx, charger };
  }

  const ref = (assetId: string, integrationRef: string | null): ChargerRef => ({ assetId, integrationRef });

  async function lockOrCreate(
    trx: Transaction<ChargingDb>,
    ctx: { bookingId: string; assetId: string; customerId: string },
    integrationKind: string,
  ): Promise<Row> {
    // One session per booking: concurrent first actions converge on the same row (UNIQUE booking_id).
    await trx
      .insertInto('charging.charging_sessions')
      .values({
        id: uuidv7(),
        booking_id: ctx.bookingId,
        asset_id: ctx.assetId,
        customer_id: ctx.customerId,
        status: 'NOT_STARTED',
        integration_kind: integrationKind,
      })
      .onConflict((oc) => oc.column('booking_id').doNothing())
      .execute();
    return trx
      .selectFrom('charging.charging_sessions')
      .selectAll()
      .where('booking_id', '=', ctx.bookingId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async function apply(
    trx: Transaction<ChargingDb>,
    row: Row,
    action: SessionAction,
    actor: Actor,
    requestId: string,
    set: Partial<{
      started_at: Date;
      ended_at: Date;
      external_ref: string | null;
      energy_wh: number | null;
      metering_source: string;
      fault_reason: string;
      fault_note: string | null;
    }>,
    reason?: string,
  ) {
    const to = nextSessionStatus(row.status as SessionStatus, action);
    if (!to) throw chargingErrors.transitionNotAllowed(row.status);
    await trx
      .updateTable('charging.charging_sessions')
      .set({ status: to, version: sql<number>`version + 1`, ...set })
      .where('id', '=', row.id)
      .execute();
    await trx
      .insertInto('charging.session_events')
      .values({
        session_id: row.id,
        from_status: row.status,
        to_status: to,
        actor_kind: actor.kind,
        actor_id: actor.userId,
        reason: reason ?? action,
        request_id: requestId,
      })
      .execute();
    if (to === 'CHARGING')
      await deps.events?.publish(
        'charging.started',
        { bookingId: row.booking_id, customerId: row.customer_id },
        trx,
      );
    if (to === 'COMPLETED' || to === 'STOPPED_EARLY') {
      const kwh = set.energy_wh == null ? null : set.energy_wh / 1000;
      await deps.events?.publish(
        'charging.completed',
        { bookingId: row.booking_id, customerId: row.customer_id, energyKwh: kwh },
        trx,
      );
    }
    return to;
  }

  async function start(customerId: string, bookingId: string, requestId: string) {
    const { ctx, charger } = await context(bookingId, { customerId });
    if (!HOLDING.includes(ctx.status)) throw chargingErrors.bookingNotActive();
    if (!canStartAt(ctx, now())) throw chargingErrors.outsideWindow();
    const integration = deps.integrations[charger.integrationKind];
    await db.transaction().execute(async (trx) => {
      const row = await lockOrCreate(trx, ctx, charger.integrationKind);
      if (!nextSessionStatus(row.status as SessionStatus, 'START'))
        throw chargingErrors.transitionNotAllowed(row.status);
      const result = await integration.startSession(ref(ctx.assetId, charger.integrationRef), {
        sessionId: row.id,
        bookingId,
      });
      if (!result.accepted) throw chargingErrors.chargerRefused();
      await apply(trx, row, 'START', { kind: 'CUSTOMER', userId: customerId }, requestId, {
        started_at: new Date(now()),
        external_ref: result.externalRef,
        metering_source: integration.metering,
      });
    });
    return view(bookingId, { customerId });
  }

  async function stop(customerId: string, bookingId: string, requestId: string) {
    const { ctx, charger } = await context(bookingId, { customerId });
    const integration = deps.integrations[charger.integrationKind];
    await db.transaction().execute(async (trx) => {
      const row = await lockOrCreate(trx, ctx, charger.integrationKind);
      const action: SessionAction = now() >= ctx.end ? 'COMPLETE' : 'STOP';
      if (!nextSessionStatus(row.status as SessionStatus, action))
        throw chargingErrors.transitionNotAllowed(row.status);
      const charger_ = ref(ctx.assetId, charger.integrationRef);
      await integration.stopSession(charger_, { sessionId: row.id, externalRef: row.external_ref });
      const energy = await integration.readEnergy(charger_, {
        sessionId: row.id,
        externalRef: row.external_ref,
      });
      await apply(trx, row, action, { kind: 'CUSTOMER', userId: customerId }, requestId, {
        ended_at: new Date(Math.min(now(), ctx.end)),
        energy_wh: energy,
      });
    });
    return view(bookingId, { customerId });
  }

  /** "Charger not working" (ux C-13 preselected). Recourse (BookingIssue CHARGER_FAULTY) is built with issues. */
  async function reportFault(
    customerId: string,
    bookingId: string,
    input: { reason: FaultReason; note: string | null },
    requestId: string,
  ) {
    const { ctx, charger } = await context(bookingId, { customerId });
    if (!HOLDING.includes(ctx.status)) throw chargingErrors.bookingNotActive();
    await db.transaction().execute(async (trx) => {
      const row = await lockOrCreate(trx, ctx, charger.integrationKind);
      await apply(
        trx,
        row,
        'FAULT',
        { kind: 'CUSTOMER', userId: customerId },
        requestId,
        {
          fault_reason: input.reason,
          fault_note: input.note,
          ...(row.status === 'CHARGING' ? { ended_at: new Date(now()) } : {}),
        },
        `fault: ${input.reason.toLowerCase()}`,
      );
      await audit.record(
        {
          actorKind: 'USER',
          actorId: customerId,
          action: 'charging.fault_reported',
          entityKind: 'booking',
          entityId: bookingId,
          metadata: { reason: input.reason },
          requestId,
        },
        trx,
      );
    });
    // V18: a charger fault opens a recourse issue (BR-24): fixed in 15 minutes, or a full refund.
    await deps.booking
      .openIssueBySystem(
        bookingId,
        'CHARGER_FAULTY',
        `${input.reason}${input.note ? `: ${input.note}` : ''}`.slice(0, 500),
        requestId,
      )
      .catch(() => undefined);
    return view(bookingId, { customerId });
  }

  async function view(bookingId: string, party: { customerId?: string; hostAccountId?: string }) {
    const { ctx, charger } = await context(bookingId, party);
    const row = await db
      .selectFrom('charging.charging_sessions')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirst();
    const status = (row?.status ?? 'NOT_STARTED') as SessionStatus;
    const t = now();
    return {
      bookingId,
      status,
      charger: {
        connectors: charger.connectors,
        currentType: charger.currentType,
        powerKw: charger.powerKw,
        speed: speedClass(charger.currentType, charger.powerKw),
        cableProvided: charger.cableProvided,
        integration: charger.integrationKind,
      },
      startedAt: row?.started_at ?? null,
      endedAt: row?.ended_at ?? null,
      energyKwh: row?.energy_wh == null ? null : Number(row.energy_wh) / 1000,
      metering: (row?.metering_source ?? charger.meteringSource) as 'NONE' | 'HOST_REPORTED' | 'CHARGER_API',
      // Planning aid only (BR-28: energy is informational without metering).
      maxEnergyKwhForBooking: maxEnergyKwh(charger.powerKw, (ctx.end - ctx.start) / 60_000),
      fault: row?.fault_reason
        ? {
            reason: row.fault_reason as FaultReason,
            note: party.customerId ? row.fault_note : row.fault_note,
          }
        : null,
      actions: {
        canStart: HOLDING.includes(ctx.status) && status === 'NOT_STARTED' && canStartAt(ctx, t),
        canStop: status === 'CHARGING',
        canReportFault: HOLDING.includes(ctx.status) && (status === 'NOT_STARTED' || status === 'CHARGING'),
      },
    };
  }

  /** Job: sessions still charging when their booking ended (or was cancelled) are closed by the system. */
  async function closeFinished(): Promise<number> {
    const open = await db
      .selectFrom('charging.charging_sessions')
      .select(['id', 'booking_id'])
      .where('status', '=', 'CHARGING')
      .limit(500)
      .execute();
    let closed = 0;
    for (const s of open) {
      const ctx = await deps.booking.chargingContext(s.booking_id);
      if (!ctx) continue;
      const over = now() >= ctx.end;
      const cancelled = !HOLDING.includes(ctx.status) && !over;
      if (!over && !cancelled) continue;
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('charging.charging_sessions')
          .selectAll()
          .where('id', '=', s.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row || row.status !== 'CHARGING') return;
        await apply(
          trx,
          row,
          over ? 'COMPLETE' : 'STOP',
          { kind: 'SYSTEM', userId: null },
          'job:charging',
          // Never before the start (clock skew or a booking shortened after the start).
          { ended_at: new Date(Math.max(over ? ctx.end : now(), row.started_at?.getTime() ?? 0)) },
          over ? 'booking ended' : 'booking no longer active',
        );
        closed += 1;
      });
    }
    return closed;
  }

  return {
    start,
    stop,
    reportFault,
    customerView: (customerId: string, bookingId: string) => view(bookingId, { customerId }),
    hostView: (hostAccountId: string, bookingId: string) => view(bookingId, { hostAccountId }),
    closeFinished,
  };
}

export type ChargingService = ReturnType<typeof createChargingService>;
