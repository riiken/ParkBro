import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { KeyedHasher } from '../../platform/crypto/keyed-hash.ts';
import type { Geocoder } from '../../platform/providers/geocoding.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import { createAiService, type AiConfig, type AiService } from './application/ai-service.ts';
import { aiAdminRoutes, aiRoutes } from './http/routes.ts';
import type { LlmProvider } from './infrastructure/llm.ts';

export { anthropicProvider, scriptedLlm, LlmError, type LlmProvider } from './infrastructure/llm.ts';
export { parseSearchText } from './domain/rules-parser.ts';
export {
  emptyIntent,
  normalise,
  redact,
  searchIntentSchema,
  type SearchIntent,
} from './domain/search-intent.ts';
export type { AiConfig } from './application/ai-service.ts';
export { evaluateSearch, type EvalReport } from './application/evaluate.ts';
export { EVAL_NOW, SEARCH_CASES } from './eval/search-cases.ts';

export interface AiModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  interpretSearch: AiService['interpretSearch'];
  usage: AiService['usage'];
  purgeOldInvocations: AiService['purgeOldInvocations'];
}

/**
 * AI layer (Phase 22, docs/ai-strategy.md): an intelligence layer, never a source of truth. It depends on no
 * marketplace module and can't change marketplace state; its only effect is a usage row in `ai.invocations`.
 */
export function createAiModule<DB>(deps: {
  db: Kysely<DB>;
  geocoder: Geocoder;
  rateLimiter: RateLimiter;
  hasher: KeyedHasher;
  llm: LlmProvider | null;
  config: AiConfig;
  now?: () => number;
}): AiModule {
  const ai = createAiService({
    db: deps.db as unknown as Kysely<unknown>,
    geocoder: deps.geocoder,
    llm: deps.llm,
    config: deps.config,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    async registerRoutes(api) {
      await api.register(aiRoutes, { ai, rateLimiter: deps.rateLimiter, hasher: deps.hasher });
      await api.register(aiAdminRoutes, { prefix: '/admin', ai });
    },
    interpretSearch: ai.interpretSearch,
    usage: ai.usage,
    purgeOldInvocations: ai.purgeOldInvocations,
  };
}
