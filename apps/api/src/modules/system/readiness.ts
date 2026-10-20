import type pg from 'pg';
import { migrationStatus, type MigrationFile } from '../../platform/db/migrator.ts';

export type CheckResult = 'ok' | 'unavailable' | 'pending' | 'error';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckResult; migrations: CheckResult };
}

export interface ReadinessProbe {
  check(): Promise<ReadinessReport>;
}

const PROBE_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('readiness probe timed out')), ms).unref(),
    ),
  ]);
}

/** Ready = database reachable and every migration on disk applied with a matching checksum. */
export function databaseReadiness(pool: pg.Pool, migrations: MigrationFile[]): ReadinessProbe {
  return {
    async check() {
      try {
        await withTimeout(pool.query('SELECT 1'), PROBE_TIMEOUT_MS);
      } catch {
        return { ready: false, checks: { database: 'unavailable', migrations: 'unavailable' } };
      }
      try {
        const status = await withTimeout(migrationStatus(pool, migrations), PROBE_TIMEOUT_MS);
        const migrationsCheck: CheckResult =
          status.problems.length > 0 ? 'error' : status.pending.length > 0 ? 'pending' : 'ok';
        return { ready: migrationsCheck === 'ok', checks: { database: 'ok', migrations: migrationsCheck } };
      } catch {
        return { ready: false, checks: { database: 'ok', migrations: 'error' } };
      }
    },
  };
}
