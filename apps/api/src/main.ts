import { buildApp } from './app.ts';
import { createModules } from './composition.ts';
import { databaseReadiness } from './modules/system/index.ts';
import { describeEnv, loadEnv } from './platform/config/env.ts';
import { MIGRATIONS_DIR } from './platform/db/cli-paths.ts';
import { createDb, createPool } from './platform/db/database.ts';
import { loadMigrations } from './platform/db/migrator.ts';
import { startJobRunner, type JobRunner } from './platform/jobs/job-runner.ts';

const env = loadEnv();
const pool = createPool(env);
const db = createDb(pool);
const modules = createModules(env, db);
const migrations = await loadMigrations(MIGRATIONS_DIR);
const app = await buildApp({
  env,
  readiness: databaseReadiness(pool, migrations),
  modules,
});

pool.on('error', (error) => app.log.error({ err: error }, 'idle database client error'));
app.log.info({ config: describeEnv(env) }, 'starting api');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await jobs?.stop();
  await app.close();
  await pool.end();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.HOST, port: env.PORT });

// After listen: the schedule needs the pgboss schema, which pg-boss creates on first start.
const jobs: JobRunner | undefined = env.JOBS_ENABLED
  ? await startJobRunner({ connectionString: env.DATABASE_URL, jobs: modules.jobs, logger: app.log })
  : undefined;
