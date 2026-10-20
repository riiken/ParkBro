import { sql, type Kysely } from 'kysely';
import { DomainError } from '../errors/domain-error.ts';

/**
 * Fixed-window counters in PostgreSQL (architecture.md §9: shared across API instances, no Redis at pilot).
 * Table platform.rate_limit_counters is UNLOGGED: losing counters on a crash is acceptable.
 */
export interface RateLimitRule {
  /** Stable key, e.g. `otp:phone:<hash>`. Never put raw PII in keys. */
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super({
      code: 'request.rate_limited',
      status: 429,
      title: 'Too many requests',
      detail: `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} and try again.`,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimiter {
  hit(rule: RateLimitRule): Promise<RateLimitResult>;
  /** Deletes windows older than a day. Run hourly by the job runner (purge-rate-limits). */
  purgeExpired(): Promise<number>;
  /** Hits every rule; throws RateLimitedError (with the longest wait) if any is exceeded. */
  enforce(...rules: RateLimitRule[]): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- works with any module's table registry
export function createRateLimiter(db: Kysely<any>): RateLimiter {
  async function hit(rule: RateLimitRule): Promise<RateLimitResult> {
    const result = await sql<{ count: number; retry_after: number }>`
      WITH w AS (
        SELECT to_timestamp(floor(extract(epoch FROM now()) / ${rule.windowSeconds}) * ${rule.windowSeconds}) AS start
      )
      INSERT INTO platform.rate_limit_counters (key, window_start, count)
      SELECT ${rule.key}, w.start, 1 FROM w
      ON CONFLICT (key, window_start) DO UPDATE SET count = platform.rate_limit_counters.count + 1
      RETURNING count,
        ceil(extract(epoch FROM (window_start + make_interval(secs => ${rule.windowSeconds}) - now())))::int AS retry_after`.execute(
      db,
    );
    const row = result.rows[0] ?? { count: 1, retry_after: rule.windowSeconds };
    return {
      allowed: row.count <= rule.limit,
      count: row.count,
      retryAfterSeconds: Math.max(1, row.retry_after),
    };
  }

  async function purgeExpired(): Promise<number> {
    const result =
      await sql`DELETE FROM platform.rate_limit_counters WHERE window_start < now() - interval '1 day'`.execute(
        db,
      );
    return Number(result.numAffectedRows ?? 0);
  }

  return {
    hit,
    purgeExpired,
    async enforce(...rules) {
      const results = await Promise.all(rules.map(hit));
      const blocked = results.filter((r) => !r.allowed);
      if (blocked.length > 0) {
        throw new RateLimitedError(Math.max(...blocked.map((r) => r.retryAfterSeconds)));
      }
    },
  };
}
