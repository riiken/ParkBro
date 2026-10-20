import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { AssetsModule } from '../assets/index.ts';
import type { BookingModule } from '../booking/index.ts';
import type { HostService } from '../identity/index.ts';
import { createChargingService } from './application/charging-service.ts';
import { defaultIntegrations, type ChargerIntegrations } from './domain/integration.ts';
import { chargingRoutes } from './http/routes.ts';
import type { ChargingDb } from './infrastructure/tables.ts';

export { speedClass, maxEnergyKwh, type SpeedClass } from './domain/session.ts';
export {
  manualIntegration,
  type ChargerIntegration,
  type ChargerIntegrations,
} from './domain/integration.ts';

export interface ChargingModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** Job: close sessions whose booking ended or stopped holding. */
  closeFinished(): Promise<number>;
}

/** EV charging sessions on top of the generic booking engine (Phase 14). Hardware-neutral (D-005). */
export function createChargingModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  booking: Pick<BookingModule, 'chargingContext' | 'openIssueBySystem'>;
  assets: Pick<AssetsModule, 'chargerProfile'>;
  hosts: HostService;
  integrations?: ChargerIntegrations;
  events?: DomainEventBus;
  now?: () => number;
}): ChargingModule {
  const db = deps.db.withTables<ChargingDb>() as unknown as Kysely<ChargingDb>;
  const charging = createChargingService({
    ...deps,
    db,
    integrations: deps.integrations ?? defaultIntegrations,
  });
  return {
    registerRoutes: async (api) => api.register(chargingRoutes, { charging, hosts: deps.hosts }),
    closeFinished: charging.closeFinished,
  };
}
