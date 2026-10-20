import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Env } from '../config/env.ts';

/**
 * Kysely table registry. Each module adds its own tables (in its own Postgres schema) as they are
 * created by migrations (database-design.md §3). Empty in Phase 7: only platform infrastructure exists.
 */
export type Database = Record<never, never>;

export type DbPool = pg.Pool;

// DATE (OID 1082) as the plain 'YYYY-MM-DD' string. The driver default builds a JS Date at *local* midnight,
// which shifts days across timezones and stringifies as "Mon Oct 20 2026 …" (found in Phase 10).
pg.types.setTypeParser(1082, (value: string) => value);

export function createPool(
  env: Pick<Env, 'DATABASE_URL' | 'DATABASE_POOL_MAX' | 'DATABASE_STATEMENT_TIMEOUT_MS'> &
    Partial<Pick<Env, 'DATABASE_SSL'>>,
) {
  const mode = env.DATABASE_SSL ?? 'url';
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ...(mode === 'url'
      ? {}
      : { ssl: mode === 'require' ? true : mode === 'no-verify' ? { rejectUnauthorized: false } : false }),
    max: env.DATABASE_POOL_MAX,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'parkbro-api',
  });
}

export function createDb(pool: DbPool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
