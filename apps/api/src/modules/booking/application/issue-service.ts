import { sql, type Kysely } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { BookingDb } from '../infrastructure/tables.ts';
import { notLapsed } from './reservations.ts';

export const ISSUE_KINDS = [
  'ACCESS_DENIED',
  'UNIT_OCCUPIED',
  'CHARGER_FAULTY',
  'HOST_UNREACHABLE',
  'CANNOT_FIND',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export type IssueStatus = 'OPEN' | 'RESOLVED_ON_SITE' | 'REFUNDED' | 'ESCALATED' | 'WITHDRAWN';

/** BR-24: the host has this long to fix it before the platform refunds the customer in full. */
export const ISSUE_RESPONSE_MINUTES = 15;
const EARLY_MINUTES = 15;

export const issueErrors = {
  notInWindow: () =>
    new DomainError({
      code: 'issue.not_in_window',
      status: 409,
      title: 'You can report a problem only around your booking time',
      detail: 'For anything else, contact support.',
    }),
  alreadyOpen: () =>
    new DomainError({
      code: 'issue.already_open',
      status: 409,
      title: 'A problem is already open for this booking',
    }),
  notOpen: () =>
    new DomainError({ code: 'issue.not_open', status: 409, title: 'This problem is already resolved' }),
};

/**
 * Booking issues: the recourse promise (domain-model §5.8, BR-24, ux §5.2). Raised in the access window; the host is
 * notified and has 15 minutes; unresolved issues end in an automatic full refund (booking CANCELLED by the platform).
 * Issues are not disputes (Phase 19): they are the fast, on-site path.
 */
export function createIssueService(deps: {
  db: Kysely<BookingDb>;
  audit: AuditLog;
  now: () => number;
  /** Publishes `booking.issue_opened` (notifications). */
  opened: (e: {
    bookingId: string;
    issueId: string;
    kind: string;
    deadlineAt: Date;
    requestId: string;
  }) => Promise<void>;
  /** Cancels the booking for the platform with a full refund (the booking engine's own cancel path). */
  refundByPlatform: (bookingId: string, reason: string, requestId: string) => Promise<unknown>;
}) {
  const { db, audit, now } = deps;

  async function bookingFacts(bookingId: string) {
    return db
      .selectFrom('booking.bookings as b')
      .select([
        'b.id',
        'b.customer_id',
        'b.host_account_id',
        'b.status',
        notLapsed.as('live'),
        sql<number>`extract(epoch FROM lower(b.period)) * 1000`.as('start_ms'),
        sql<number>`extract(epoch FROM upper(b.period)) * 1000`.as('end_ms'),
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
  }

  async function open(
    bookingId: string,
    input: { kind: IssueKind; note: string | null; reporter: 'CUSTOMER' | 'SYSTEM'; customerId?: string },
    requestId: string,
  ) {
    const b = await bookingFacts(bookingId);
    if (!b || (input.customerId && b.customer_id !== input.customerId)) throw errors.notFound();
    const t = now();
    if (
      !['CONFIRMED', 'IN_PROGRESS'].includes(b.status) ||
      t < Number(b.start_ms) - EARLY_MINUTES * 60_000 ||
      t >= Number(b.end_ms)
    ) {
      throw issueErrors.notInWindow();
    }
    const id = uuidv7();
    try {
      await db
        .insertInto('booking.booking_issues')
        .values({
          id,
          booking_id: bookingId,
          kind: input.kind,
          reporter_kind: input.reporter,
          note: input.note,
          status: 'OPEN',
          deadline_at: new Date(t + ISSUE_RESPONSE_MINUTES * 60_000),
        })
        .execute();
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'booking_issues_open_uq')
        throw issueErrors.alreadyOpen();
      throw error;
    }
    await audit.record({
      actorKind: input.reporter === 'CUSTOMER' ? 'USER' : 'SYSTEM',
      actorId: input.customerId ?? null,
      action: 'booking_issue.opened',
      entityKind: 'booking',
      entityId: bookingId,
      metadata: { kind: input.kind },
      requestId,
    });
    await deps.opened({
      bookingId,
      issueId: id,
      kind: input.kind,
      deadlineAt: new Date(t + ISSUE_RESPONSE_MINUTES * 60_000),
      requestId,
    });
    return id;
  }

  async function settle(
    issueId: string,
    status: Exclude<IssueStatus, 'OPEN'>,
    by: 'CUSTOMER' | 'HOST' | 'SYSTEM' | 'PLATFORM',
    note: string | null,
  ) {
    const res = await db
      .updateTable('booking.booking_issues')
      .set({ status, resolved_at: new Date(now()), resolved_by: by, resolution_note: note })
      .where('id', '=', issueId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw issueErrors.notOpen();
  }

  async function issueOf(issueId: string) {
    return db
      .selectFrom('booking.booking_issues as i')
      .innerJoin('booking.bookings as b', 'b.id', 'i.booking_id')
      .select(['i.id', 'i.booking_id', 'i.status', 'b.customer_id', 'b.host_account_id'])
      .where('i.id', '=', issueId)
      .executeTakeFirst();
  }

  /** Host: fixed on site, or hand to support. */
  async function hostRespond(
    hostAccountId: string,
    userId: string,
    issueId: string,
    outcome: 'RESOLVED_ON_SITE' | 'ESCALATED',
    note: string | null,
    requestId: string,
  ) {
    const i = await issueOf(issueId);
    if (!i || i.host_account_id !== hostAccountId) throw errors.notFound();
    await settle(issueId, outcome, 'HOST', note);
    await audit.record({
      actorKind: 'USER',
      actorId: userId,
      action: `booking_issue.${outcome.toLowerCase()}`,
      entityKind: 'booking',
      entityId: i.booking_id,
      requestId,
    });
  }

  /** Customer: "it's sorted" (withdraw) or "still stuck" (escalate to support). */
  async function customerRespond(
    customerId: string,
    issueId: string,
    outcome: 'WITHDRAWN' | 'ESCALATED',
    requestId: string,
  ) {
    const i = await issueOf(issueId);
    if (!i || i.customer_id !== customerId) throw errors.notFound();
    await settle(issueId, outcome, 'CUSTOMER', null);
    await audit.record({
      actorKind: 'USER',
      actorId: customerId,
      action: `booking_issue.${outcome.toLowerCase()}`,
      entityKind: 'booking',
      entityId: i.booking_id,
      requestId,
    });
  }

  /** Job: deadline passed with no fix → full refund (BR-24). Escalated issues wait for support instead. */
  async function autoResolve(): Promise<number> {
    const due = await db
      .selectFrom('booking.booking_issues')
      .select(['id', 'booking_id', 'kind'])
      .where('status', '=', 'OPEN')
      .where('deadline_at', '<=', new Date(now()))
      .limit(100)
      .execute();
    let n = 0;
    for (const i of due) {
      try {
        await deps.refundByPlatform(
          i.booking_id,
          `RECOURSE_${i.kind}: host did not resolve within ${ISSUE_RESPONSE_MINUTES} minutes`,
          'job:issues',
        );
        await settle(i.id, 'REFUNDED', 'SYSTEM', 'automatic full refund');
        n += 1;
      } catch {
        // The booking may have changed meanwhile (e.g. completed): leave it for support.
        await settle(i.id, 'ESCALATED', 'SYSTEM', 'automatic refund not possible').catch(() => undefined);
      }
    }
    return n;
  }

  async function openIssueFor(bookingId: string) {
    const row = await db
      .selectFrom('booking.booking_issues')
      .select(['id', 'kind', 'status', 'deadline_at', 'note', 'created_at'])
      .where('booking_id', '=', bookingId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          kind: row.kind as IssueKind,
          status: row.status as IssueStatus,
          deadlineAt: row.deadline_at,
          note: row.note,
          createdAt: row.created_at,
        }
      : null;
  }

  async function hasOpenIssue(bookingId: string) {
    return !!(await db
      .selectFrom('booking.booking_issues')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst());
  }

  return {
    open,
    hostRespond,
    customerRespond,
    autoResolve,
    latestFor: openIssueFor,
    hasOpenIssue,
    bookingFacts,
  };
}

export type IssueService = ReturnType<typeof createIssueService>;
