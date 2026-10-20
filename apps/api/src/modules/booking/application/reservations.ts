import { sql, type Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../../platform/audit/audit-log.ts';
import type { Reservation, ReservationSource } from '../../availability/index.ts';
import type { BookingDb } from '../infrastructure/tables.ts';

/**
 * Holding bookings as reservations (Phase 11 seam, D-085). A lapsed payment hold or approval window never blocks
 * availability, even before the expiry job has marked it EXPIRED (BR-10, D-041).
 */
export const notLapsed = sql<boolean>`NOT (
  (b.status = 'PENDING_PAYMENT' AND b.hold_expires_at <= now())
  OR (b.status = 'AWAITING_HOST_APPROVAL' AND b.approval_expires_at <= now())
)`;

const range = (from: number, to: number) =>
  sql`tstzrange(to_timestamp(${from / 1000}), to_timestamp(${to / 1000}), '[)')`;

export function bookingReservationSource(db: Kysely<BookingDb>): ReservationSource & {
  forProperty(
    propertyId: string,
    from: number,
    to: number,
    executor?: AnyKyselyExecutor,
  ): Promise<{ start: number; end: number }[]>;
} {
  const exec = (executor?: AnyKyselyExecutor) => (executor as unknown as Kysely<BookingDb> | undefined) ?? db;
  return {
    async holdingReservations(unitIds, from, to, executor): Promise<Reservation[]> {
      if (unitIds.length === 0) return [];
      const rows = await exec(executor)
        .selectFrom('booking.bookings as b')
        .select([
          'b.unit_id',
          sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
          sql<number>`extract(epoch FROM upper(b.blocked_period)) * 1000`.as('blocked_until_ms'),
        ])
        .where('b.unit_id', 'in', [...unitIds])
        .where('b.holds_unit', '=', true)
        .where(notLapsed)
        .where(sql<boolean>`b.blocked_period && ${range(from, to)}`)
        .execute();
      return rows.map((r) => ({
        unitId: r.unit_id,
        start: Number(r.start_ms),
        blockedUntil: Number(r.blocked_until_ms),
      }));
    },
    /** Holding bookings across a property (outsider cap, BR-06), as booked periods (buffers don't count as vehicles present). */
    async forProperty(propertyId, from, to, executor) {
      const rows = await exec(executor)
        .selectFrom('booking.bookings as b')
        .select([
          sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
          sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
        ])
        .where('b.property_id', '=', propertyId)
        .where('b.holds_unit', '=', true)
        .where(notLapsed)
        .where(sql<boolean>`b.period && ${range(from, to)}`)
        .execute();
      return rows.map((r) => ({ start: Number(r.start_ms), end: Number(r.end_ms) }));
    },
  };
}
