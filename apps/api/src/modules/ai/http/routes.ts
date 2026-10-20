import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../../../platform/auth/authentication.ts';
import type { KeyedHasher } from '../../../platform/crypto/keyed-hash.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import type { AiService } from '../application/ai-service.ts';
import { MAX_TEXT_LENGTH } from '../domain/search-intent.ts';

const filters = z.object({
  type: z.enum(['PARKING', 'EV_CHARGING']),
  place: z.object({ name: z.string(), latitude: z.number(), longitude: z.number() }).nullable(),
  useMyLocation: z.boolean(),
  mode: z.string().nullable(),
  date: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  maxPricePaise: z.number().nullable(),
  covered: z.boolean(),
  security: z.array(z.enum(['CCTV', 'GUARD', 'GATED'])),
  evReady: z.boolean(),
  vehicleClass: z.string().nullable(),
  connector: z.string().nullable(),
  currentType: z.enum(['AC', 'DC']).nullable(),
  minPowerKw: z.number().nullable(),
});

/**
 * Natural-language search (C-01, Phase 22). Anonymous like search itself; rate limited per IP and capped by a daily
 * model budget. The answer is filters for the regular search, which alone decides availability and prices.
 */
export const aiRoutes: FastifyPluginAsync<{
  ai: AiService;
  rateLimiter: RateLimiter;
  hasher: KeyedHasher;
}> = async (app, { ai, rateLimiter, hasher }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limit = async (request: FastifyRequest, bucket: string, perMinute: number, perDay: number) => {
    const ip = hasher.hash('ai.rate_limit_ip', request.ip).toString('hex').slice(0, 32);
    await rateLimiter.enforce({ key: `${bucket}:ip1m:${ip}`, limit: perMinute, windowSeconds: 60 });
    await rateLimiter.enforce({ key: `${bucket}:ip1d:${ip}`, limit: perDay, windowSeconds: 86_400 });
  };

  r.post(
    '/v1/ai/search-intent',
    {
      schema: {
        tags: ['ai'],
        body: z.object({ text: z.string().trim().min(3).max(MAX_TEXT_LENGTH) }),
        response: {
          200: z.object({
            id: z.uuid(),
            filters,
            chips: z.array(z.string()),
            notes: z.array(z.string()),
            answeredBy: z.enum(['model', 'rules']),
          }),
        },
      },
    },
    async (request) => {
      await limit(request, 'ai-search', 10, 200);
      return ai.interpretSearch(request.body.text);
    },
  );

  r.post(
    '/v1/ai/search-intent/:id/feedback',
    {
      schema: {
        tags: ['ai'],
        params: z.object({ id: z.uuid() }),
        body: z.object({ helpful: z.boolean() }),
      },
    },
    async (request, reply) => {
      await limit(request, 'ai-feedback', 20, 200);
      if (!(await ai.feedback(request.params.id, request.body.helpful))) throw errors.notFound();
      return reply.status(204).send();
    },
  );
};

/** AI usage for admins: model, cost, latency, errors, fallbacks, tool calls, feedback (PHASES.md Phase 22). */
export const aiAdminRoutes: FastifyPluginAsync<{ ai: AiService }> = async (app, { ai }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/ai/usage',
    {
      preHandler: requirePermission('SUPPORT', 'TRUST_SAFETY', 'FINANCE'),
      schema: {
        tags: ['admin'],
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      },
    },
    async (request) => ai.usage(request.query.days),
  );
};
