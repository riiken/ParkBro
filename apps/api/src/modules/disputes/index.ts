import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { ObjectStorage } from '../../platform/providers/object-storage.ts';
import type { AccessModule } from '../access/index.ts';
import type { BookingModule } from '../booking/index.ts';
import type { IdentityModule } from '../identity/index.ts';
import type { PaymentsModule } from '../payments/index.ts';
import type { ReviewsModule } from '../reviews/index.ts';
import { createDisputeService, type DisputeService } from './application/dispute-service.ts';
import { disputeAdminRoutes, disputeRoutes } from './http/routes.ts';
import type { DisputesDb } from './infrastructure/tables.ts';

export interface DisputesModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** Earnings hold (BR-18). */
  hasOpenDispute: DisputeService['hasOpenDispute'];
}

/** Disputes (Phase 19): evidence, timeline, human resolution. */
export function createDisputesModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  events: DomainEventBus;
  storage: ObjectStorage;
  booking: Pick<BookingModule, 'partiesOf' | 'eventsOf'>;
  identity: Pick<IdentityModule, 'hostMemberIds' | 'customerNameForHost'>;
  payments: Pick<PaymentsModule, 'adminBookingMoney' | 'refundForDispute'>;
  access: Pick<AccessModule, 'bookingAccessLog'>;
  reviews: Pick<ReviewsModule, 'customerTrust' | 'hostTrust' | 'forAdmin'>;
  now?: () => number;
}): DisputesModule {
  const db = deps.db.withTables<DisputesDb>() as unknown as Kysely<DisputesDb>;
  const disputes = createDisputeService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(disputeRoutes, { disputes });
      await api.register(disputeAdminRoutes, { prefix: '/admin', disputes });
    },
    hasOpenDispute: disputes.hasOpenDispute,
  };
}
