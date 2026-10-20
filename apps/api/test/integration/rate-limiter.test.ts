import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/platform/db/cli-paths.ts';
import { createDb } from '../../src/platform/db/database.ts';
import { loadMigrations, migrate } from '../../src/platform/db/migrator.ts';
import { RateLimitedError, createRateLimiter } from '../../src/platform/rate-limit/rate-limiter.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await migrate(db.pool, await loadMigrations(MIGRATIONS_DIR), { info: () => undefined });
});
afterAll(async () => {
  await db.drop();
});

describe('Postgres rate limiter', () => {
  it('counts concurrent hits exactly (shared across API instances)', async () => {
    const limiter = createRateLimiter(createDb(db.pool));
    const rule = { key: 'test:concurrent', limit: 10, windowSeconds: 3600 };
    const results = await Promise.all(Array.from({ length: 30 }, () => limiter.hit(rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });

  it('enforce throws with the longest wait when any rule is exceeded', async () => {
    const limiter = createRateLimiter(createDb(db.pool));
    const short = { key: 'test:short', limit: 1, windowSeconds: 30 };
    const long = { key: 'test:long', limit: 1, windowSeconds: 3600 };
    await limiter.enforce(short, long);
    const error = await limiter.enforce(short, long).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBeGreaterThan(30);
  });

  it('keys are independent', async () => {
    const limiter = createRateLimiter(createDb(db.pool));
    await limiter.hit({ key: 'test:a', limit: 1, windowSeconds: 60 });
    expect((await limiter.hit({ key: 'test:b', limit: 1, windowSeconds: 60 })).allowed).toBe(true);
  });
});

describe('retention', () => {
  it('purges windows older than a day and keeps recent ones', async () => {
    const limiter = createRateLimiter(createDb(db.pool));
    await db.pool.query(
      `INSERT INTO platform.rate_limit_counters (key, window_start, count) VALUES ('old', now() - interval '2 days', 1), ('recent', now(), 1)`,
    );
    expect(await limiter.purgeExpired()).toBeGreaterThanOrEqual(1);
    const keys = (
      await db.pool.query(`SELECT key FROM platform.rate_limit_counters WHERE key IN ('old','recent')`)
    ).rows;
    expect(keys).toEqual([{ key: 'recent' }]);
  });
});
