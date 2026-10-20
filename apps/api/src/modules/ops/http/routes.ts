import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requirePermission } from '../../../platform/auth/authentication.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import type { OpsHealth } from '../ops-health.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * `GET /api/health/ops` for an external monitor (alerting): bearer `OPS_MONITOR_TOKEN`; 503 when any check is
 * critical so any uptime tool can page on it. Counts and check names only. Disabled (404) without a token.
 */
export const opsMonitorRoutes: FastifyPluginAsync<{ ops: OpsHealth; token: string | undefined }> = async (
  app,
  { ops, token },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/health/ops', { schema: { tags: ['system'] } }, async (request, reply) => {
    if (!token) throw errors.notFound();
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!timingSafeEqual(digest(given), digest(token))) throw errors.unauthenticated();
    const report = await ops.report();
    return reply.status(report.status === 'critical' ? 503 : 200).send({
      status: report.status,
      at: report.at,
      checks: report.checks.map(({ name, status, value }) => ({ name, status, value })),
    });
  });
};

/** The same report with thresholds and runbook text, for any admin (console dashboard). */
export const opsAdminRoutes: FastifyPluginAsync<{ ops: OpsHealth }> = async (app, { ops }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/ops/health',
    { preHandler: requirePermission('SUPPORT', 'TRUST_SAFETY', 'FINANCE'), schema: { tags: ['admin'] } },
    async () => ops.report(),
  );
};
