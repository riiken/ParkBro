import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { opsAdminRoutes, opsMonitorRoutes } from './http/routes.ts';
import { createOpsHealth, type OpsHealth } from './ops-health.ts';

export type { OpsCheck } from './ops-health.ts';

export interface OpsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  report: OpsHealth['report'];
}

/** Operational health and alerting (Phase 23, production-readiness §5): a read-only query module. */
export function createOpsModule<DB>(deps: {
  db: Kysely<DB>;
  monitorToken: string | undefined;
  now?: () => number;
}): OpsModule {
  const ops = createOpsHealth({
    db: deps.db as unknown as Kysely<unknown>,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    async registerRoutes(api) {
      await api.register(opsMonitorRoutes, { ops, token: deps.monitorToken });
      await api.register(opsAdminRoutes, { prefix: '/admin', ops });
    },
    report: ops.report,
  };
}
