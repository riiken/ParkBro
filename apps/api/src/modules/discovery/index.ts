import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import './domain/events.ts';
import type { KeyedHasher } from '../../platform/crypto/keyed-hash.ts';
import type { Geocoder } from '../../platform/providers/geocoding.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import type { ReservationSource } from '../availability/index.ts';
import { createDiscoveryService } from './application/discovery-service.ts';
import { discoveryRoutes } from './http/routes.ts';
import type { DiscoveryDb } from './infrastructure/views.ts';

export interface DiscoveryModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
}

/**
 * Discovery (Phase 10): a read-only query module. It can only read the discovery.* views, which contain no
 * exact location, address, access instructions or unpublished data (architecture.md §4.2 rule 3, L-9).
 */
export function createDiscoveryModule<DB>(deps: {
  db: Kysely<DB>;
  geocoder: Geocoder;
  rateLimiter: RateLimiter;
  hasher: KeyedHasher;
  reservations: ReservationSource;
  events?: DomainEventBus;
  now?: () => number;
}): DiscoveryModule {
  const db = deps.db.withTables<DiscoveryDb>() as unknown as Kysely<DiscoveryDb>;
  const discovery = createDiscoveryService({
    db,
    reservations: deps.reservations,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    async registerRoutes(api) {
      await api.register(discoveryRoutes, {
        discovery,
        geocoder: deps.geocoder,
        rateLimiter: deps.rateLimiter,
        hasher: deps.hasher,
        // Analytics signals are best effort: a failure never breaks a search (D-159).
        signal: async (type, payload) => {
          await deps.events?.publish(type, payload, deps.db).catch(() => undefined);
        },
      });
    },
  };
}
