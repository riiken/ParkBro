import { parseSearchText } from '../domain/rules-parser.ts';
import { redact, searchIntentSchema, type SearchIntent } from '../domain/search-intent.ts';
import type { EvalCase } from '../eval/search-cases.ts';
import type { LlmProvider } from '../infrastructure/llm.ts';
import { SEARCH_TOOL, systemPrompt } from './ai-service.ts';

export interface EvalReport {
  answeredBy: string;
  cases: number;
  fields: number;
  correctFields: number;
  accuracy: number;
  invalidOutputs: number;
  errors: number;
  latencyMs: { p50: number | null; p95: number | null };
  tokens: { input: number; output: number };
  failures: { text: string; field: string; expected: unknown; got: unknown }[];
}

const same = (field: string, a: unknown, b: unknown) => {
  if (field === 'place') return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  if (Array.isArray(a) && Array.isArray(b)) return [...a].sort().join() === [...b].sort().join();
  return a === b;
};
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
};

/**
 * Field-level accuracy of a model (or the rules parser when `llm` is null) on the evaluation set, with latency and
 * tokens (docs/ai-strategy.md §6). Uses the production prompt and tool, so a pass means production behaves.
 */
export async function evaluateSearch(
  llm: LlmProvider | null,
  cases: EvalCase[],
  nowMs: number,
  timeoutMs = 10_000,
) {
  const report: EvalReport = {
    answeredBy: llm ? `${llm.name}:${llm.model}` : 'rules',
    cases: cases.length,
    fields: 0,
    correctFields: 0,
    accuracy: 0,
    invalidOutputs: 0,
    errors: 0,
    latencyMs: { p50: null, p95: null },
    tokens: { input: 0, output: 0 },
    failures: [],
  };
  const latencies: number[] = [];
  for (const c of cases) {
    const text = redact(c.text);
    let got: SearchIntent | null = null;
    if (!llm) got = parseSearchText(text, nowMs);
    else {
      const t0 = performance.now();
      try {
        const out = await llm.callTool({
          system: systemPrompt(nowMs),
          user: `Request: """${text}"""`,
          tool: SEARCH_TOOL,
          maxTokens: 400,
          timeoutMs,
        });
        latencies.push(performance.now() - t0);
        report.tokens.input += out.inputTokens;
        report.tokens.output += out.outputTokens;
        const parsed = searchIntentSchema.safeParse(out.input);
        if (parsed.success) got = parsed.data;
        else report.invalidOutputs += 1;
      } catch {
        report.errors += 1;
      }
    }
    for (const [field, expected] of Object.entries(c.expect)) {
      report.fields += 1;
      const value = got ? got[field as keyof SearchIntent] : undefined;
      if (got && same(field, expected, value)) report.correctFields += 1;
      else report.failures.push({ text: c.text, field, expected, got: value });
    }
  }
  report.accuracy = report.fields ? report.correctFields / report.fields : 0;
  report.latencyMs = { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95) };
  return report;
}
