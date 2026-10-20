import { sql, type Kysely } from 'kysely';

export type Level = 'ok' | 'warn' | 'critical' | 'unknown';

export interface OpsCheck {
  name: string;
  area: 'booking' | 'payments' | 'earnings' | 'notifications' | 'access' | 'disputes' | 'ai' | 'jobs';
  value: number;
  warnAt: number;
  criticalAt: number | null;
  status: Level;
  /** What it means and what to do (production-readiness §5 runbook). */
  meaning: string;
}

type Def = Omit<OpsCheck, 'value' | 'status'> & {
  query: (now: Date) => ReturnType<typeof sql<{ n: string }>>;
};

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

/**
 * Operational health for alerting (Phase 23, production-readiness §5). Each check counts a symptom that should be
 * zero (or small) when jobs, providers and support queues are healthy. Read-only over the systems of record; counts
 * only, no personal data. Thresholds are deliberately conservative for the pilot.
 */
const CHECKS: Def[] = [
  {
    name: 'holds_not_expired',
    area: 'booking',
    warnAt: 1,
    criticalAt: 10,
    meaning: 'Unpaid holds 5+ min past expiry: the expire-holds job is not running. Units look booked.',
    query: (now) => sql`SELECT count(*) AS n FROM booking.bookings
      WHERE status = 'PENDING_PAYMENT' AND hold_expires_at < ${minutesAgo(now, 5)}`,
  },
  {
    name: 'approvals_not_expired',
    area: 'booking',
    warnAt: 1,
    criticalAt: 10,
    meaning: 'Requests 15+ min past their approval deadline: the booking-transitions job is not running.',
    query: (now) => sql`SELECT count(*) AS n FROM booking.bookings
      WHERE status = 'AWAITING_HOST_APPROVAL' AND approval_expires_at < ${minutesAgo(now, 15)}`,
  },
  {
    name: 'bookings_not_completed',
    area: 'booking',
    warnAt: 1,
    criticalAt: 20,
    meaning:
      'Bookings 1+ h past their end still open: the booking-transitions job is failing; earnings stall.',
    query: (now) => sql`SELECT count(*) AS n FROM booking.bookings
      WHERE status IN ('CONFIRMED', 'IN_PROGRESS') AND upper(period) < ${minutesAgo(now, 60)}`,
  },
  {
    name: 'issues_past_deadline',
    area: 'access',
    warnAt: 1,
    criticalAt: 1,
    meaning:
      '"Can\'t get in" issues 5+ min past the host deadline with no recourse: the booking-issues job is down. A customer may be stuck at a gate.',
    query: (now) => sql`SELECT count(*) AS n FROM booking.booking_issues
      WHERE status = 'OPEN' AND deadline_at < ${minutesAgo(now, 5)}`,
  },
  {
    name: 'issues_escalated_24h',
    area: 'access',
    warnAt: 1,
    criticalAt: null,
    meaning: 'Issues escalated to support in the last 24 h: check each has been handled.',
    query: (now) => sql`SELECT count(*) AS n FROM booking.booking_issues
      WHERE status = 'ESCALATED' AND resolved_at >= ${minutesAgo(now, 24 * 60)}`,
  },
  {
    name: 'payments_awaiting_confirmation',
    area: 'payments',
    warnAt: 1,
    criticalAt: 10,
    meaning:
      'Payments pending 30+ min: webhooks are not arriving and reconciliation is not catching up. Check provider status and webhook delivery.',
    query: (now) => sql`SELECT count(*) AS n FROM payments.payments
      WHERE status = 'PENDING' AND created_at < ${minutesAgo(now, 30)}`,
  },
  {
    name: 'payment_mismatches_7d',
    area: 'payments',
    warnAt: 1,
    criticalAt: 3,
    meaning:
      'Payments whose provider amount/order did not match the booking (quarantined, refunded automatically). Investigate each.',
    query: (now) => sql`SELECT count(*) AS n FROM payments.payments
      WHERE mismatch AND created_at >= ${minutesAgo(now, 7 * 24 * 60)}`,
  },
  {
    name: 'refunds_stuck',
    area: 'payments',
    warnAt: 1,
    criticalAt: 5,
    meaning:
      'Refunds not completed after 2 h: the refund job or provider is failing. Customers are waiting for money.',
    query: (now) => sql`SELECT count(*) AS n FROM payments.refunds
      WHERE status IN ('PENDING', 'SUBMITTED') AND created_at < ${minutesAgo(now, 120)}`,
  },
  {
    name: 'refunds_failed_7d',
    area: 'payments',
    warnAt: 1,
    criticalAt: 1,
    meaning: 'Refunds the provider rejected: finance must resolve each manually.',
    query: (now) => sql`SELECT count(*) AS n FROM payments.refunds
      WHERE status = 'FAILED' AND updated_at >= ${minutesAgo(now, 7 * 24 * 60)}`,
  },
  {
    name: 'payouts_processing_3d',
    area: 'earnings',
    warnAt: 1,
    criticalAt: null,
    meaning: 'Payouts sent to finance 3+ days ago and not marked paid or failed.',
    query: (now) => sql`SELECT count(*) AS n FROM payouts.payouts
      WHERE status = 'PROCESSING' AND created_at < ${minutesAgo(now, 3 * 24 * 60)}`,
  },
  {
    name: 'notifications_backlog',
    area: 'notifications',
    warnAt: 5,
    criticalAt: 50,
    meaning: 'Messages due 10+ min ago and not sent: the delivery job or messaging provider is failing.',
    query: (now) => sql`SELECT count(*) AS n FROM notifications.notifications
      WHERE status IN ('PENDING', 'SENDING') AND next_attempt_at < ${minutesAgo(now, 10)}`,
  },
  {
    name: 'notifications_failed_24h',
    area: 'notifications',
    warnAt: 5,
    criticalAt: 50,
    meaning: 'Messages that gave up in the last 24 h: check the provider and templates.',
    query: (now) => sql`SELECT count(*) AS n FROM notifications.notifications
      WHERE status = 'FAILED' AND updated_at >= ${minutesAgo(now, 24 * 60)}`,
  },
  {
    name: 'high_risk_disputes_waiting',
    area: 'disputes',
    warnAt: 1,
    criticalAt: null,
    meaning: 'High-risk disputes (damage, misconduct) open 24+ h: trust & safety must review.',
    query: (now) => sql`SELECT count(*) AS n FROM disputes.disputes
      WHERE risk = 'HIGH' AND status NOT IN ('RESOLVED', 'CLOSED') AND created_at < ${minutesAgo(now, 24 * 60)}`,
  },
  {
    name: 'data_requests_overdue',
    area: 'disputes',
    warnAt: 1,
    criticalAt: null,
    meaning:
      'Data-rights requests (access, correction, erasure) past their due date: a legal obligation (DPDP).',
    query: (now) =>
      sql`SELECT count(*) AS n FROM users.data_requests WHERE status = 'OPEN' AND due_at < ${now}`,
  },
  {
    name: 'ai_model_failures_1h',
    area: 'ai',
    warnAt: 10,
    criticalAt: null,
    meaning:
      'Model timeouts/errors in the last hour (search still works on the rules parser). Check the provider or switch AI_PROVIDER=none.',
    query: (now) => sql`SELECT count(*) AS n FROM ai.invocations
      WHERE fallback_reason IN ('TIMEOUT', 'ERROR') AND at >= ${minutesAgo(now, 60)}`,
  },
  {
    name: 'jobs_failed_24h',
    area: 'jobs',
    warnAt: 1,
    criticalAt: 20,
    meaning: 'Scheduled job runs that failed in the last 24 h (pg-boss). See error logs for the job name.',
    query: (now) => sql`SELECT count(*) AS n FROM pgboss.job
      WHERE state = 'failed' AND created_on >= ${minutesAgo(now, 24 * 60)}`,
  },
];

const level = (value: number, warnAt: number, criticalAt: number | null): Level =>
  criticalAt !== null && value >= criticalAt ? 'critical' : value >= warnAt ? 'warn' : 'ok';

export function createOpsHealth(deps: { db: Kysely<unknown>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  return {
    async report() {
      const at = new Date(now());
      const checks: OpsCheck[] = await Promise.all(
        CHECKS.map(async ({ query, ...def }) => {
          try {
            const value = Number((await query(at).execute(deps.db)).rows[0]?.n ?? 0);
            return { ...def, value, status: level(value, def.warnAt, def.criticalAt) };
          } catch {
            // e.g. pg-boss schema absent when jobs never started: unknown, not a false alarm.
            return { ...def, value: 0, status: 'unknown' as const };
          }
        }),
      );
      const status: Level = checks.some((c) => c.status === 'critical')
        ? 'critical'
        : checks.some((c) => c.status === 'warn')
          ? 'warn'
          : 'ok';
      return { status, at, checks };
    },
  };
}

export type OpsHealth = ReturnType<typeof createOpsHealth>;
