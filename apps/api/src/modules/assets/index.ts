import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../platform/crypto/field-cipher.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { ObjectStorage } from '../../platform/providers/object-storage.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import type { AvailabilityModule, ReservationSource } from '../availability/index.ts';
import type { HostService } from '../identity/index.ts';
import type { PricingModule } from '../pricing/index.ts';
import type { PropertiesModule } from '../properties/index.ts';
import type { TrustModule } from '../trust/index.ts';
import { createAssetService, type AssetService } from './application/asset-service.ts';
import { assetAdminRoutes, assetHostRoutes } from './http/routes.ts';
import type { AssetsDb } from './infrastructure/tables.ts';

export type { AssetStatus } from './domain/state-machine.ts';

export interface AssetsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  bookingContext: AssetService['bookingContext'];
  revealAccess: AssetService['revealAccess'];
  unitLabel: AssetService['unitLabel'];
  chargerProfile: AssetService['chargerProfile'];
  riskSignals: AssetService['riskSignals'];
}

export type BookingContext = NonNullable<Awaited<ReturnType<AssetService['bookingContext']>>>;

/** Generic asset management (Phase 9): PARKING and EV_CHARGING listings on one engine (D-001, D-012, D-013). */
export function createAssetsModule<DB>(deps: {
  db: Kysely<DB>;
  cipher: FieldCipher;
  audit: AuditLog;
  events: DomainEventBus;
  storage: ObjectStorage;
  rateLimiter: RateLimiter;
  hosts: HostService;
  properties: PropertiesModule;
  pricing: PricingModule;
  availability: AvailabilityModule;
  trust: TrustModule;
  reservations: ReservationSource;
  now?: () => number;
}): AssetsModule {
  const db = deps.db.withTables<AssetsDb>() as unknown as Kysely<AssetsDb>;
  const assets = createAssetService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(assetHostRoutes, { assets, hosts: deps.hosts });
      await api.register(assetAdminRoutes, { prefix: '/admin', assets });
    },
    bookingContext: assets.bookingContext,
    revealAccess: assets.revealAccess,
    unitLabel: assets.unitLabel,
    chargerProfile: assets.chargerProfile,
    riskSignals: assets.riskSignals,
  };
}
