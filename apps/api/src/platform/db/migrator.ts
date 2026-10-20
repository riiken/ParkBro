import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/**
 * Forward-only plain-SQL migrations (database-design.md §13, architecture.md §12).
 *
 * - Files: `NNNN_snake_case_name.sql`, applied in version order, each in its own transaction unless the
 *   file starts with `-- migrate:no-transaction` (needed for e.g. CREATE INDEX CONCURRENTLY).
 * - A session advisory lock serialises concurrent runners (several instances deploying at once).
 * - Applied files are checksummed; editing or deleting an applied migration is a hard error.
 */

export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_HEADER = /^\s*--\s*migrate:no-transaction\b/;
const LOCK_KEY = 4_809_217_311; // arbitrary constant: "parkbro migrations"

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrationStatus {
  applied: number[];
  pending: MigrationFile[];
  problems: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new MigrationError(`Invalid migration filename "${filename}" (expected NNNN_snake_case.sql)`);
    }
    const sql = await readFile(path.join(dir, filename), 'utf8');
    const version = Number(match[1]);
    if (files.some((f) => f.version === version)) {
      throw new MigrationError(`Duplicate migration version ${version} ("${filename}")`);
    }
    files.push({
      version,
      name: match[2] ?? '',
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transactional: !NO_TRANSACTION_HEADER.test(sql),
    });
  }
  return files;
}

async function ensureBookkeeping(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      version      integer PRIMARY KEY,
      name         text NOT NULL,
      checksum     text NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL
    );`);
}

async function appliedRows(client: pg.PoolClient | pg.Pool) {
  const exists = await client.query<{ present: boolean }>(
    `SELECT to_regclass('platform.schema_migrations') IS NOT NULL AS present`,
  );
  if (!exists.rows[0]?.present) return [];
  const result = await client.query<{ version: number; checksum: string; name: string }>(
    'SELECT version, checksum, name FROM platform.schema_migrations ORDER BY version',
  );
  return result.rows;
}

function compare(files: MigrationFile[], applied: { version: number; checksum: string; name: string }[]) {
  const problems: string[] = [];
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      problems.push(`Applied migration ${row.version} (${row.name}) is missing from disk`);
    } else if (file.checksum !== row.checksum) {
      problems.push(
        `Applied migration ${file.filename} was modified after being applied (checksum mismatch)`,
      );
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  const maxApplied = Math.max(0, ...appliedVersions);
  for (const f of pending) {
    if (f.version < maxApplied) {
      problems.push(`Migration ${f.filename} is older than the latest applied migration (${maxApplied})`);
    }
  }
  return { applied: [...appliedVersions].sort((a, b) => a - b), pending, problems };
}

/** Read-only status (used by `db:status` and the readiness probe). */
export async function migrationStatus(pool: pg.Pool, files: MigrationFile[]): Promise<MigrationStatus> {
  return compare(files, await appliedRows(pool));
}

export interface MigrateLogger {
  info(message: string): void;
}

/** Apply all pending migrations. Returns the versions applied by this call. */
export async function migrate(pool: pg.Pool, files: MigrationFile[], log: MigrateLogger): Promise<number[]> {
  const client = await pool.connect();
  try {
    // The lock is held for the whole run; statement_timeout is lifted for long migrations.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureBookkeeping(client);

    const status = compare(files, await appliedRows(client));
    if (status.problems.length > 0) {
      throw new MigrationError(`Refusing to migrate:\n  - ${status.problems.join('\n  - ')}`);
    }

    const done: number[] = [];
    for (const file of status.pending) {
      const started = performance.now();
      if (file.transactional) await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO platform.schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, Math.round(performance.now() - started)],
        );
        if (file.transactional) await client.query('COMMIT');
      } catch (error) {
        if (file.transactional) await client.query('ROLLBACK');
        throw new MigrationError(
          `Migration ${file.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      log.info(`applied ${file.filename}`);
      done.push(file.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
