import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { databaseReadiness } from '../../src/modules/system/index.ts';
import { MIGRATIONS_DIR } from '../../src/platform/db/cli-paths.ts';
import { createPool } from '../../src/platform/db/database.ts';
import { loadMigrations, migrate } from '../../src/platform/db/migrator.ts';
import { testEnv } from '../helpers.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.drop();
});

async function ready(pool: pg.Pool) {
  const app = await buildApp({
    env: testEnv({ LOG_LEVEL: 'silent' }),
    readiness: databaseReadiness(pool, await loadMigrations(MIGRATIONS_DIR)),
  });
  const res = await app.inject({ url: '/api/health/ready' });
  await app.close();
  return { status: res.statusCode, body: res.json() as unknown };
}

describe('readiness against a real database', () => {
  it('is 503 with migrations pending on an unmigrated database', async () => {
    expect(await ready(db.pool)).toEqual({
      status: 503,
      body: { status: 'unavailable', checks: { database: 'ok', migrations: 'pending' } },
    });
  });

  it('is 200 once all migrations are applied', async () => {
    await migrate(db.pool, await loadMigrations(MIGRATIONS_DIR), { info: () => undefined });
    expect(await ready(db.pool)).toEqual({
      status: 200,
      body: { status: 'ok', checks: { database: 'ok', migrations: 'ok' } },
    });
  });

  it('is 503 quickly when the database is unreachable', async () => {
    const unreachable = createPool(
      testEnv({ DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/none' }) as Parameters<
        typeof createPool
      >[0],
    );
    const started = Date.now();
    const result = await ready(unreachable);
    expect(result).toEqual({
      status: 503,
      body: { status: 'unavailable', checks: { database: 'unavailable', migrations: 'unavailable' } },
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    await unreachable.end();
  });
});

describe('database pool', () => {
  it('applies the configured statement timeout and application name', async () => {
    const pool = createPool(testEnv({ DATABASE_URL: db.url, DATABASE_STATEMENT_TIMEOUT_MS: '1500' }));
    const res = await pool.query<{ statement_timeout: string; application_name: string }>(
      `SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('application_name') AS application_name`,
    );
    expect(res.rows[0]).toEqual({ statement_timeout: '1500ms', application_name: 'parkbro-api' });
    await expect(pool.query('SELECT pg_sleep(3)')).rejects.toThrow(/statement timeout/);
    await pool.end();
  });
});
