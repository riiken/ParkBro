import type { FastifyServerOptions } from 'fastify';
import type { Env } from '../config/env.ts';

/**
 * Paths censored anywhere they appear in a log object (trust-and-safety.md §14, architecture.md §9).
 * Handlers must still avoid logging PII; this is the safety net, not the policy.
 */
export const REDACTED_PATHS = [
  'password',
  'token',
  'otp',
  'accessCode',
  'phone',
  'plate',
  'address',
  'cookie',
  'authorization',
  'secret',
  '*.password',
  '*.token',
  '*.otp',
  '*.accessCode',
  '*.phone',
  '*.plate',
  '*.address',
  '*.cookie',
  '*.authorization',
  '*.secret',
  'headers.cookie',
  'headers.authorization',
  'req.headers.cookie',
  'req.headers.authorization',
];

/** Minimal log sink (pino destination); tests pass an in-memory stream. */
export interface LogStream {
  write(line: string): void;
}

export function loggerOptions(env: Env, stream?: LogStream): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: {
      // Log the route pattern, never the raw URL: query strings and path tokens can carry secrets.
      req: (req: { method: string; routeOptions?: { url?: string | undefined } }) => ({
        method: req.method,
        route: req.routeOptions?.url ?? '(unmatched)',
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    ...(stream === undefined ? {} : { stream }),
  };
}
