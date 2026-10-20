import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import type { AssetsModule } from '../assets/index.ts';
import type { AvailabilityModule, ReservationSource } from '../availability/index.ts';
import type { IdentityModule } from '../identity/index.ts';
import type { PricingModule } from '../pricing/index.ts';
import type { PropertiesModule } from '../properties/index.ts';
import type { UsersModule } from '../users/index.ts';
import { createBookingService, type BookingService } from './application/booking-service.ts';
import { bookingReservationSource } from './application/reservations.ts';
import { bookingAdminRoutes } from './http/admin-routes.ts';
import { bookingRoutes } from './http/routes.ts';
import type { BookingDb } from './infrastructure/tables.ts';

export { BOOKING_STATUSES, type BookingStatus } from './domain/state-machine.ts';
export { CANCELLATION_POLICIES } from './domain/cancellation.ts';
export { NO_SHOW_GRACE_MINUTES } from './application/booking-service.ts';
export { SERIES_STATUSES, type SeriesStatus } from './domain/series.ts';
export { HOLD_MINUTES, APPROVAL_HOURS } from './application/booking-service.ts';
export type { RefundCause } from './domain/events.ts';
export { ISSUE_KINDS, ISSUE_RESPONSE_MINUTES, type IssueKind } from './application/issue-service.ts';

export interface BookingModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** PAYMENT_SUCCEEDED: called only by the payments module on a verified provider event (Phase 15, BR-15). */
  confirmPayment: BookingService['confirmPayment'];
  expireLapsedHolds: BookingService['expireLapsedHolds'];
  completeFinished: BookingService['completeFinished'];
  /** Monthly plans: renewals, overdue, grace and notice (job, every 5 minutes). */
  seriesTick: BookingService['series']['tick'];
  /** Booking facts for the charging module. */
  chargingContext: BookingService['chargingContext'];
  /** Booking facts for the payments module. */
  paymentContext: BookingService['paymentContext'];
  /** Price facts for the ledger (Phase 16). */
  earningsContext: BookingService['earningsContext'];
  /** Access: verified entry or "I'm here" (CONFIRMED → IN_PROGRESS). */
  checkIn: BookingService['checkIn'];
  /** Charging faults open a recourse issue. */
  openIssueBySystem: BookingService['issues']['openBySystem'];
  /** Job: unresolved issues past their deadline → full refund (BR-24). */
  autoResolveIssues: BookingService['issues']['autoResolve'];
  /** Notifications: recipients and timing. */
  partiesOf: BookingService['partiesOf'];
  scheduleFeed: BookingService['scheduleFeed'];
  /** Reviews, trust and disputes. */
  eventsOf: BookingService['eventsOf'];
  customerStats: BookingService['customerStats'];
  hostStats: BookingService['hostStats'];
  /** Admin: fraud indicators from booking history. */
  riskSignals: BookingService['riskSignals'];
}

/**
 * Holding reservations, for availability consumers (assets calendar, discovery). Built before the booking module
 * itself because assets and discovery are constructed first (composition root).
 */
export function createBookingReservations<DB>(db: Kysely<DB>): ReservationSource {
  return bookingReservationSource(db.withTables<BookingDb>() as unknown as Kysely<BookingDb>);
}

/** Generic, asset-independent booking engine (Phase 12; domain-model §5.3, BR-07 … BR-22). */
export function createBookingModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  identity: IdentityModule;
  users: UsersModule;
  properties: PropertiesModule;
  assets: AssetsModule;
  availability: AvailabilityModule;
  pricing: PricingModule;
  events: DomainEventBus;
  /** Pilot clearance gate (D-168); absent = every signed-in customer may book. */
  customerCleared?: (customerId: string) => Promise<boolean>;
  now?: () => number;
}): BookingModule {
  const db = deps.db.withTables<BookingDb>() as unknown as Kysely<BookingDb>;
  const bookings = createBookingService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(bookingRoutes, { bookings, hosts: deps.identity.hosts });
      await api.register(bookingAdminRoutes, { prefix: '/admin', bookings });
    },
    confirmPayment: bookings.confirmPayment,
    expireLapsedHolds: bookings.expireLapsedHolds,
    completeFinished: bookings.completeFinished,
    seriesTick: bookings.series.tick,
    chargingContext: bookings.chargingContext,
    paymentContext: bookings.paymentContext,
    earningsContext: bookings.earningsContext,
    checkIn: bookings.checkIn,
    openIssueBySystem: bookings.issues.openBySystem,
    autoResolveIssues: bookings.issues.autoResolve,
    partiesOf: bookings.partiesOf,
    scheduleFeed: bookings.scheduleFeed,
    eventsOf: bookings.eventsOf,
    customerStats: bookings.customerStats,
    hostStats: bookings.hostStats,
    riskSignals: bookings.riskSignals,
  };
}
