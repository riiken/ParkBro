import { anthropicProvider, evaluateSearch, EVAL_NOW, SEARCH_CASES } from '../modules/ai/index.ts';
import { loadEnv } from '../platform/config/env.ts';

/**
 * `pnpm ai:eval` (docs/ai-strategy.md §6): run the configured model (AI_PROVIDER=anthropic + key) over the
 * natural-language search evaluation set with the production prompt; without a model, evaluates the rules parser.
 * Exits non-zero below 90 % field accuracy, the bar for enabling a model or changing the prompt.
 */
const env = loadEnv(process.env);
const llm =
  env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY
    ? anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL, apiBase: env.AI_API_BASE })
    : null;
const report = await evaluateSearch(llm, SEARCH_CASES, EVAL_NOW);
const costUsd =
  (report.tokens.input * env.AI_COST_INPUT_USD_PER_MTOK +
    report.tokens.output * env.AI_COST_OUTPUT_USD_PER_MTOK) /
  1_000_000;
console.log(
  JSON.stringify(
    { ...report, estimatedCostUsd: Math.round(costUsd * 1e6) / 1e6, failures: report.failures },
    null,
    2,
  ),
);
process.exitCode = report.accuracy >= 0.9 ? 0 : 1;
