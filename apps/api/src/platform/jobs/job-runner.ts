import { PgBoss } from 'pg-boss';

/** A periodic maintenance task. `run` must be idempotent and safe to run concurrently with requests. */
export interface ScheduledJob {
  name: string;
  /** 5-field cron, UTC. pg-boss schedules are minute-granular. */
  cron: string;
  /** Returns the number of rows affected, for logs and metrics. */
  run: () => Promise<number>;
}

export interface JobRunner {
  stop(): Promise<void>;
}

/**
 * pg-boss in its own `pgboss` schema (architecture §7, D-095). The schedule is shared across API instances and each
 * tick is a single job, so a task runs once per tick however many instances are up. Queue policy `singleton` keeps
 * at most one active run per task.
 */
export async function startJobRunner(options: {
  connectionString: string;
  jobs: readonly ScheduledJob[];
  logger: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
}): Promise<JobRunner> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: 'pgboss',
    max: 2,
    application_name: 'parkbro-jobs',
  });
  boss.on('error', (error) => options.logger.error({ err: error }, 'job runner error'));
  await boss.start();
  for (const job of options.jobs) {
    await boss.createQueue(job.name, { policy: 'singleton', retryLimit: 0, expireInSeconds: 300 });
    await boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
    await boss.work(job.name, async () => {
      const started = Date.now();
      try {
        const affected = await job.run();
        if (affected > 0)
          options.logger.info({ job: job.name, affected, ms: Date.now() - started }, 'job ran');
      } catch (error) {
        options.logger.error({ err: error, job: job.name }, 'job failed');
        throw error;
      }
    });
  }
  return { stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
