import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** A fresh, empty database per test file; dropped afterwards. Never touches the development database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `parkbro_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
