import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDependencies } from '../src/app.ts';
import {
  DEV_ONLY_BLIND_INDEX_KEY,
  DEV_ONLY_FIELD_ENCRYPTION_KEYS,
  loadEnv,
  type Env,
} from '../src/platform/config/env.ts';
import type { ReadinessProbe } from '../src/modules/system/index.ts';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/unused',
    FIELD_ENCRYPTION_KEYS: DEV_ONLY_FIELD_ENCRYPTION_KEYS,
    BLIND_INDEX_KEY: DEV_ONLY_BLIND_INDEX_KEY,
    ...overrides,
  });
}

export const alwaysReady: ReadinessProbe = {
  check: async () => ({ ready: true, checks: { database: 'ok', migrations: 'ok' } }),
};

/** Collects every log line the app writes, parsed. */
export function captureLogs() {
  const lines: string[] = [];
  return {
    stream: { write: (line: string) => void lines.push(line) },
    raw: () => lines.join(''),
    entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export async function testApp(deps: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  // Silent unless the test captures logs.
  const env = testEnv({ LOG_LEVEL: deps.logStream ? 'info' : 'silent' });
  const app = await buildApp({ env, readiness: alwaysReady, ...deps });
  await app.ready();
  return app;
}
