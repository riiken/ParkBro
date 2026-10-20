import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../platform/crypto/field-cipher.ts';
import type { KeyedHasher } from '../../platform/crypto/keyed-hash.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import type { AssetsModule } from '../assets/index.ts';
import type { BookingModule } from '../booking/index.ts';
import type { HostService } from '../identity/index.ts';
import type { PropertiesModule } from '../properties/index.ts';
import type { UsersModule } from '../users/index.ts';
import { createAccessService, type AccessService } from './application/access-service.ts';
import { noAdapters, type AccessAdapters } from './domain/adapters.ts';
import { accessAdminRoutes, accessHostRoutes, accessRoutes } from './http/routes.ts';
import type { AccessDb } from './infrastructure/tables.ts';

export type { AccessAdapter, AccessAdapters, ExternalAccessEvent } from './domain/adapters.ts';

export interface AccessModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** External systems (ANPR, smart locks, gate controllers) report events here. */
  ingestExternal: AccessService['ingestExternal'];
  /** Dispute evidence. */
  bookingAccessLog: AccessService['bookingAccessLog'];
}

/** Access management (Phase 17): grants from confirmed bookings, guard links, digital pass, access log. */
export function createAccessModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  cipher: FieldCipher;
  hasher: KeyedHasher;
  rateLimiter: RateLimiter;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'checkIn'>;
  users: Pick<UsersModule, 'plateKeys' | 'plateIndex' | 'vehicleById'>;
  assets: Pick<AssetsModule, 'unitLabel' | 'revealAccess'>;
  properties: Pick<PropertiesModule, 'exactAddress' | 'hostRelation'>;
  hosts: HostService;
  adapters?: AccessAdapters;
  now?: () => number;
}): AccessModule {
  const db = deps.db.withTables<AccessDb>() as unknown as Kysely<AccessDb>;
  const access = createAccessService({ ...deps, db, adapters: deps.adapters ?? noAdapters });
  return {
    async registerRoutes(api) {
      await api.register(accessRoutes, { access });
      await api.register(accessHostRoutes, { access, hosts: deps.hosts });
      await api.register(accessAdminRoutes, { prefix: '/admin', access });
    },
    ingestExternal: access.ingestExternal,
    bookingAccessLog: access.bookingAccessLog,
  };
}
