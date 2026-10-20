import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { BookingModule } from '../booking/index.ts';
import type { HostService, IdentityModule } from '../identity/index.ts';
import { createReviewService, type ReviewService } from './application/review-service.ts';
import { reviewAdminRoutes, reviewRoutes } from './http/routes.ts';
import type { ReviewsDb } from './infrastructure/tables.ts';

export interface ReviewsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  publishDue: ReviewService['publishDue'];
  customerTrust: ReviewService['customerTrust'];
  hostTrust: ReviewService['hostTrust'];
  forAdmin: ReviewService['forAdmin'];
}

/** Reviews and trust signals (Phase 19). */
export function createReviewsModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  booking: Pick<BookingModule, 'partiesOf' | 'customerStats' | 'hostStats'>;
  identity: Pick<IdentityModule, 'hostMemberIds' | 'customerNameForHost'>;
  hosts: HostService;
  now?: () => number;
}): ReviewsModule {
  const db = deps.db.withTables<ReviewsDb>() as unknown as Kysely<ReviewsDb>;
  const reviews = createReviewService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(reviewRoutes, { reviews, hosts: deps.hosts });
      await api.register(reviewAdminRoutes, { prefix: '/admin', reviews });
    },
    publishDue: reviews.publishDue,
    customerTrust: reviews.customerTrust,
    hostTrust: reviews.hostTrust,
    forAdmin: reviews.forAdmin,
  };
}
