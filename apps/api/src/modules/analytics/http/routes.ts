import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../../../platform/auth/authentication.ts';
import type { MetricsService } from '../application/metrics-service.ts';

/** Marketplace analytics for every admin role (A-06): aggregate numbers only, no personal data (D-160). */
export const analyticsAdminRoutes: FastifyPluginAsync<{ metrics: MetricsService }> = async (
  app,
  { metrics },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('SUPPORT', 'TRUST_SAFETY', 'FINANCE');
  const days = z.coerce.number().int().min(1).max(365).default(30);

  r.get(
    '/v1/analytics/overview',
    { preHandler: guard, schema: { tags: ['admin'], querystring: z.object({ days }) } },
    async (request) => metrics.overview(request.query.days),
  );
  r.get(
    '/v1/analytics/liquidity',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        querystring: z.object({ days, type: z.enum(['PARKING', 'EV_CHARGING']).optional() }),
      },
    },
    async (request) => metrics.liquidity(request.query.days, request.query.type),
  );
};
