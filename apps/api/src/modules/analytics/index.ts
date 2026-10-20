import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import { createMetricsService, type MetricsService } from './application/metrics-service.ts';
import { analyticsAdminRoutes } from './http/routes.ts';

export { EVENT_RETENTION_DAYS } from './application/metrics-service.ts';

export interface AnalyticsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  overview: MetricsService['overview'];
  liquidity: MetricsService['liquidity'];
  purgeOldEvents: MetricsService['purgeOldEvents'];
}

/**
 * Analytics & marketplace intelligence (Phase 21). Records the anonymous discovery signals and reports supply,
 * demand, marketplace and liquidity metrics computed from the systems of record (docs/analytics.md).
 */
export function createAnalyticsModule<DB>(deps: {
  db: Kysely<DB>;
  events: DomainEventBus;
  now?: () => number;
}): AnalyticsModule {
  const metrics = createMetricsService({
    db: deps.db as unknown as Kysely<unknown>,
    ...(deps.now ? { now: deps.now } : {}),
  });
  deps.events.subscribe('discovery.searched', (e, executor) => metrics.recordSearch(e, executor));
  deps.events.subscribe('discovery.listing_viewed', (e, executor) => metrics.recordView(e, executor));
  return {
    registerRoutes: async (api) => api.register(analyticsAdminRoutes, { prefix: '/admin', metrics }),
    overview: metrics.overview,
    liquidity: metrics.liquidity,
    purgeOldEvents: metrics.purgeOldEvents,
  };
}
