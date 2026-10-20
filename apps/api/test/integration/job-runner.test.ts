import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startJobRunner } from '../../src/platform/jobs/job-runner.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe('job runner', () => {
  it('installs pg-boss in its own schema, registers one schedule per job, and stops cleanly', async () => {
    const logs: string[] = [];
    const runner = await startJobRunner({
      connectionString: db.url,
      jobs: [
        { name: 'expire-holds', cron: '* * * * *', run: async () => 0 },
        { name: 'purge-quotes', cron: '17 * * * *', run: async () => 0 },
      ],
      logger: { info: (_o, m) => logs.push(m), error: (_o, m) => logs.push(m) },
    });
    try {
      const schedules = await db.pool.query(`SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name`);
      expect(schedules.rows).toEqual([
        { name: 'expire-holds', cron: '* * * * *', timezone: 'UTC' },
        { name: 'purge-quotes', cron: '17 * * * *', timezone: 'UTC' },
      ]);
    } finally {
      await runner.stop();
    }
    expect(logs).not.toContain('job runner error');
  });
});
