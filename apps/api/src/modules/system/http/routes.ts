import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ReadinessProbe } from '../readiness.ts';

const check = z.enum(['ok', 'unavailable', 'pending', 'error']);
const readinessBody = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({ database: check, migrations: check }),
});

export const systemRoutes: FastifyPluginAsync<{ readiness: ReadinessProbe }> = async (app, { readiness }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/health/live',
    { schema: { tags: ['system'], response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  r.get(
    '/health/ready',
    { schema: { tags: ['system'], response: { 200: readinessBody, 503: readinessBody } } },
    async (_request, reply) => {
      const report = await readiness.check();
      return reply
        .status(report.ready ? 200 : 503)
        .send({ status: report.ready ? 'ok' : 'unavailable', checks: report.checks });
    },
  );
};
