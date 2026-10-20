/**
 * Model seam (D-163). The AI layer asks a model for exactly one forced tool call and gets its arguments back
 * unvalidated; validation, authorisation and every effect live in application code. No SDK dependency: one HTTPS
 * call is all the pilot needs.
 */
export interface ToolCallRequest {
  system: string;
  user: string;
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  maxTokens: number;
  timeoutMs: number;
}

export interface ToolCallResult {
  input: unknown;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'scripted';
  readonly model: string;
  callTool(request: ToolCallRequest): Promise<ToolCallResult>;
}

/** Failure kinds the service maps to a fallback reason. */
export class LlmError extends Error {
  readonly kind: 'TIMEOUT' | 'ERROR';
  readonly code: string;
  constructor(kind: 'TIMEOUT' | 'ERROR', code: string) {
    super(`llm ${kind.toLowerCase()}: ${code}`);
    this.kind = kind;
    this.code = code;
  }
}

/** Anthropic Messages API with a forced tool (structured output). Text never leaves except the redacted request. */
export function anthropicProvider(options: {
  apiKey: string;
  model: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): LlmProvider {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? 'https://api.anthropic.com';
  return {
    name: 'anthropic',
    model: options.model,
    async callTool(req) {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: req.maxTokens,
            temperature: 0,
            system: req.system,
            tools: [
              { name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema },
            ],
            tool_choice: { type: 'tool', name: req.tool.name },
            messages: [{ role: 'user', content: req.user }],
          }),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        throw new LlmError(timeout ? 'TIMEOUT' : 'ERROR', timeout ? 'timeout' : 'network');
      }
      if (!res.ok) {
        // Status only: provider error bodies can echo the request.
        throw new LlmError('ERROR', `http_${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as {
        content?: { type: string; name?: string; input?: unknown }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      } | null;
      const call = body?.content?.find((c) => c.type === 'tool_use' && c.name === req.tool.name);
      if (!call) throw new LlmError('ERROR', 'no_tool_call');
      return {
        input: call.input,
        inputTokens: body?.usage?.input_tokens ?? 0,
        outputTokens: body?.usage?.output_tokens ?? 0,
      };
    },
  };
}

/** Tests and evaluation dry-runs: answers come from a function (which may throw an LlmError or return junk). */
export function scriptedLlm(
  answer: (req: ToolCallRequest) => unknown | Promise<unknown>,
  model = 'scripted-1',
): LlmProvider & { calls: ToolCallRequest[] } {
  const calls: ToolCallRequest[] = [];
  return {
    name: 'scripted',
    model,
    calls,
    async callTool(req) {
      calls.push(req);
      const input = await answer(req);
      return { input, inputTokens: 400, outputTokens: 60 };
    },
  };
}
