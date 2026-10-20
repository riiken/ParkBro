import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../config/env.ts';
import { MIGRATIONS_DIR } from './cli-paths.ts';
import { createPool } from './database.ts';
import { loadMigrations, migrate, migrationStatus } from './migrator.ts';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const files = await loadMigrations(MIGRATIONS_DIR);

  if (command === 'new') {
    const name = (args[0] ?? '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('usage: db:new <snake_case_name>');
    const next = String(Math.max(0, ...files.map((f) => f.version)) + 1).padStart(4, '0');
    const file = path.join(MIGRATIONS_DIR, `${next}_${name}.sql`);
    await writeFile(file, `-- ${next} ${name}: <what and why; link the design doc section>\n`, {
      flag: 'wx',
    });
    console.log(`created ${path.relative(process.cwd(), file)}`);
    return;
  }

  const env = loadEnv();
  const pool = createPool(env);
  try {
    if (command === 'migrate') {
      const applied = await migrate(pool, files, { info: (m) => console.log(m) });
      console.log(applied.length === 0 ? 'database is up to date' : `applied ${applied.length} migration(s)`);
    } else if (command === 'status') {
      const status = await migrationStatus(pool, files);
      console.log(`applied: ${status.applied.join(', ') || '(none)'}`);
      console.log(`pending: ${status.pending.map((f) => f.filename).join(', ') || '(none)'}`);
      for (const problem of status.problems) console.log(`PROBLEM: ${problem}`);
      if (status.problems.length > 0) process.exitCode = 1;
    } else {
      throw new Error('usage: cli.ts migrate | status | new <name>');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
