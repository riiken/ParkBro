import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/platform/db/cli-paths.ts';
import { MigrationError, loadMigrations, migrate, migrationStatus } from '../../src/platform/db/migrator.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';

const quiet = { info: () => undefined };
let db: TestDatabase;
const dirs: string[] = [];

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pb-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.drop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('repository migrations', () => {
  it('apply cleanly to an empty database and install the required extensions', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    expect(await migrate(db.pool, files, quiet)).toEqual(files.map((f) => f.version));
    const ext = await db.pool.query<{ extname: string }>('SELECT extname FROM pg_extension');
    expect(ext.rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['postgis', 'btree_gist', 'pgcrypto']),
    );
    const status = await migrationStatus(db.pool, files);
    expect(status).toMatchObject({ pending: [], problems: [] });
  });

  it('are idempotent: a second run applies nothing', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    await migrate(db.pool, files, quiet);
    expect(await migrate(db.pool, files, quiet)).toEqual([]);
  });

  it('install working append-only and updated_at helpers', async () => {
    await migrate(db.pool, await loadMigrations(MIGRATIONS_DIR), quiet);
    await db.pool.query(`
      CREATE TABLE t (id int PRIMARY KEY, v int, updated_at timestamptz NOT NULL DEFAULT 'epoch');
      CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
      CREATE TABLE log (id int);
      CREATE TRIGGER log_ro BEFORE UPDATE OR DELETE ON log FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
      INSERT INTO t VALUES (1, 1); INSERT INTO log VALUES (1);`);
    await db.pool.query('UPDATE t SET v = 2');
    const touched = await db.pool.query<{ fresh: boolean }>(
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM t`,
    );
    expect(touched.rows[0]?.fresh).toBe(true);
    await expect(db.pool.query('DELETE FROM log')).rejects.toThrow(/append-only/);
  });
});

describe('migrator safety', () => {
  it('rolls back a failing migration completely and records nothing', async () => {
    const dir = await dirWith({
      '0001_ok.sql': 'CREATE TABLE a (id int);',
      '0002_bad.sql': 'CREATE TABLE b (id int); SELECT * FROM does_not_exist;',
    });
    await expect(migrate(db.pool, await loadMigrations(dir), quiet)).rejects.toThrow(/0002_bad.sql failed/);
    const tables = await db.pool.query(`SELECT to_regclass('public.a') AS a, to_regclass('public.b') AS b`);
    expect(tables.rows[0]).toEqual({ a: 'a', b: null });
    const status = await migrationStatus(db.pool, await loadMigrations(dir));
    expect(status.applied).toEqual([1]);
    expect(status.pending.map((f) => f.version)).toEqual([2]);
  });

  it('detects an applied migration that was edited and refuses to run', async () => {
    const dir = await dirWith({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    await migrate(db.pool, await loadMigrations(dir), quiet);
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
    const files = await loadMigrations(dir);
    expect((await migrationStatus(db.pool, files)).problems[0]).toMatch(/modified after being applied/);
    await expect(migrate(db.pool, files, quiet)).rejects.toThrow(MigrationError);
  });

  it('detects an applied migration missing from disk', async () => {
    const dir = await dirWith({ '0001_a.sql': 'SELECT 1;', '0002_b.sql': 'SELECT 2;' });
    await migrate(db.pool, await loadMigrations(dir), quiet);
    await rm(path.join(dir, '0002_b.sql'));
    expect((await migrationStatus(db.pool, await loadMigrations(dir))).problems[0]).toMatch(
      /missing from disk/,
    );
  });

  it('runs no-transaction migrations (CREATE INDEX CONCURRENTLY)', async () => {
    const dir = await dirWith({
      '0001_t.sql': 'CREATE TABLE t (id int);',
      '0002_ix.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_id_ix ON t (id);',
    });
    expect(await migrate(db.pool, await loadMigrations(dir), quiet)).toEqual([1, 2]);
  });

  it('serialises concurrent runners: each migration is applied exactly once', async () => {
    const dir = await dirWith({
      '0001_slow.sql': 'CREATE TABLE slow (id int); SELECT pg_sleep(1);',
      '0002_next.sql': 'CREATE TABLE next_t (id int);',
    });
    const files = await loadMigrations(dir);
    const results = await Promise.all([migrate(db.pool, files, quiet), migrate(db.pool, files, quiet)]);
    expect(results.flat().sort()).toEqual([1, 2]);
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM platform.schema_migrations');
    expect(rows.rows[0]).toEqual({ n: 2 });
  });
});
