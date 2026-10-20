import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationError, loadMigrations } from '../../src/platform/db/migrator.ts';
import { MIGRATIONS_DIR } from '../../src/platform/db/cli-paths.ts';

const dirs: string[] = [];
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pb-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadMigrations', () => {
  it('loads, orders and checksums files, detecting the no-transaction header', async () => {
    const dir = await dirWith({
      '0002_second.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);',
      '0001_first.sql': 'SELECT 1;',
      'README.md': 'ignored',
    });
    const files = await loadMigrations(dir);
    expect(files.map((f) => [f.version, f.name, f.transactional])).toEqual([
      [1, 'first', true],
      [2, 'second', false],
    ]);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects badly named SQL files instead of silently skipping them', async () => {
    const dir = await dirWith({ '1_bad-name.sql': 'SELECT 1;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('rejects duplicate versions', async () => {
    const dir = await dirWith({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' });
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version 1/);
  });

  it('the repository migrations directory is valid', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => i + 1));
  });
});
