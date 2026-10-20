import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../platform/crypto/field-cipher.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { HostService } from '../identity/index.ts';
import { createPropertyService, type ListingContext } from './application/property-service.ts';
import type { ParticipationStatus } from './domain/participation.ts';
import { propertyAdminRoutes, propertyHostRoutes } from './http/routes.ts';
import type { PropertiesDb } from './infrastructure/tables.ts';
import './domain/events.ts';

export type { ListingContext } from './application/property-service.ts';
export type { ParticipationStatus } from './domain/participation.ts';
export { participationHaltsListings } from './domain/participation.ts';
export { haversineMeters, type LatLng, type PropertyKind } from './domain/geo.ts';

export interface PropertiesModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  listingContext(propertyId: string, hostAccountId: string): Promise<ListingContext | null>;
  exactPoint(propertyId: string): Promise<{ latitude: number; longitude: number } | null>;
  timezoneOf(propertyId: string): Promise<string | null>;
  lockForBooking(
    propertyId: string,
    executor: unknown,
  ): Promise<{
    timezone: string;
    outsiderCap: number | null;
    participationStatus: ParticipationStatus;
  } | null>;
  exactAddress(propertyId: string): Promise<string | null>;
  /** The host's relation to a property (OWNER or MEMBER_HOST); 404 if none. */
  hostRelation(propertyId: string, hostAccountId: string): Promise<{ relation: 'OWNER' | 'MEMBER_HOST' }>;
}

/** Properties & societies (Phase 9). */
export function createPropertiesModule<DB>(deps: {
  db: Kysely<DB>;
  cipher: FieldCipher;
  audit: AuditLog;
  events: DomainEventBus;
  hosts: HostService;
  random?: () => number;
}): PropertiesModule {
  const db = deps.db.withTables<PropertiesDb>() as unknown as Kysely<PropertiesDb>;
  const properties = createPropertyService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(propertyHostRoutes, { properties, hosts: deps.hosts });
      await api.register(propertyAdminRoutes, { prefix: '/admin', properties, hosts: deps.hosts });
    },
    listingContext: properties.listingContext,
    exactPoint: properties.exactPoint,
    timezoneOf: properties.timezoneOf,
    lockForBooking: properties.lockForBooking,
    exactAddress: properties.exactAddress,
    hostRelation: async (propertyId, hostAccountId) => ({
      relation: (await properties.getHostProperty(propertyId, hostAccountId)).relation,
    }),
  };
}
