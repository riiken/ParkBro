import { sql, type Kysely, type Selectable } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import type { AdminPermission } from '../../../platform/auth/actor.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { ObjectStorage } from '../../../platform/providers/object-storage.ts';
import { CONTACT_DETAILS_MESSAGE, findContactDetails } from '../../../platform/text/contact-details.ts';
import type { AccessModule } from '../../access/index.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { IdentityModule } from '../../identity/index.ts';
import type { PaymentsModule } from '../../payments/index.ts';
import type { ReviewsModule } from '../../reviews/index.ts';
import {
  DISPUTE_WINDOW_DAYS,
  isOpen,
  nextDisputeStatus,
  riskOf,
  type AdminAction,
  type Category,
  type Outcome,
  type Status,
} from '../domain/dispute.ts';
import { processEvidence } from '../infrastructure/evidence-images.ts';
import type { DisputesDb, DisputesTable } from '../infrastructure/tables.ts';

type Row = Selectable<DisputesTable>;
type Party = 'CUSTOMER' | 'HOST';
const MAX_EVIDENCE = 10;

export const disputeErrors = {
  notAllowed: () =>
    new DomainError({
      code: 'dispute.not_allowed',
      status: 409,
      title: 'A dispute can be opened from the booking start until 7 days after it ends',
    }),
  alreadyOpen: () =>
    new DomainError({
      code: 'dispute.already_open',
      status: 409,
      title: 'You already have an open dispute for this booking',
    }),
  closed: () => new DomainError({ code: 'dispute.closed', status: 409, title: 'This dispute is resolved' }),
  transition: (from: string) =>
    new DomainError({
      code: 'dispute.transition_not_allowed',
      status: 409,
      title: 'That action is not available',
      detail: `The dispute is ${from.toLowerCase().replaceAll('_', ' ')}.`,
    }),
  highRisk: () =>
    new DomainError({
      code: 'dispute.trust_safety_only',
      status: 403,
      title: 'High-risk disputes are resolved by trust & safety',
      detail: 'Damage and misconduct need a TRUST_SAFETY admin decision.',
    }),
  contact: () =>
    new DomainError({
      code: 'dispute.contact_details',
      status: 400,
      title: 'Remove contact details',
      detail: CONTACT_DETAILS_MESSAGE,
    }),
  tooMuchEvidence: () =>
    new DomainError({
      code: 'evidence.limit_reached',
      status: 409,
      title: `Up to ${MAX_EVIDENCE} photos per dispute`,
    }),
};

declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    /** Something the parties should know happened on a dispute (notifications). */
    'dispute.updated': { disputeId: string; bookingId: string; notify: Party[] };
  }
}

/**
 * Disputes (Phase 19; CLAUDE.md §18). First-class entities with a timeline and evidence. Resolution is a human
 * decision: only an admin session can resolve, HIGH-risk categories only with TRUST_SAFETY, and there is no system
 * or AI path that resolves anything (structural: `resolve` requires an admin actor). Refunds go through payments.
 */
export function createDisputeService(deps: {
  db: Kysely<DisputesDb>;
  audit: AuditLog;
  events: DomainEventBus;
  storage: ObjectStorage;
  booking: Pick<BookingModule, 'partiesOf' | 'eventsOf'>;
  identity: Pick<IdentityModule, 'hostMemberIds' | 'customerNameForHost'>;
  payments: Pick<PaymentsModule, 'adminBookingMoney' | 'refundForDispute'>;
  access: Pick<AccessModule, 'bookingAccessLog'>;
  reviews: Pick<ReviewsModule, 'customerTrust' | 'hostTrust' | 'forAdmin'>;
  now?: () => number;
}) {
  const { db, audit, events, storage } = deps;
  const now = deps.now ?? Date.now;

  async function partyOf(userId: string, bookingId: string) {
    const p = await deps.booking.partiesOf(bookingId);
    if (!p) throw errors.notFound();
    if (p.customerId === userId) return { p, kind: 'CUSTOMER' as Party };
    if ((await deps.identity.hostMemberIds(p.hostAccountId)).includes(userId))
      return { p, kind: 'HOST' as Party };
    throw errors.notFound();
  }

  async function disputeFor(userId: string, disputeId: string) {
    const d = await db
      .selectFrom('disputes.disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .executeTakeFirst();
    if (!d) throw errors.notFound();
    const { kind } = await partyOf(userId, d.booking_id);
    return { d, kind };
  }

  const other = (k: Party): Party => (k === 'CUSTOMER' ? 'HOST' : 'CUSTOMER');
  const updated = (d: Row, notify: Party[]) =>
    events.publish('dispute.updated', { disputeId: d.id, bookingId: d.booking_id, notify }, db);

  async function open(
    userId: string,
    bookingId: string,
    input: {
      category: Category;
      description: string;
      requestedOutcome: 'REFUND' | 'PARTIAL_REFUND' | 'COMPENSATION' | 'REVIEW_ONLY' | 'OTHER';
    },
    requestId: string,
  ) {
    const { p, kind } = await partyOf(userId, bookingId);
    const t = now();
    const reachable = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(p.status);
    if (
      !reachable ||
      t >= p.end + DISPUTE_WINDOW_DAYS * 86_400_000 ||
      (p.status !== 'CANCELLED' && t < p.start)
    )
      throw disputeErrors.notAllowed();
    if (findContactDetails(input.description)) throw disputeErrors.contact();
    const id = uuidv7();
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('disputes.disputes')
          .values({
            id,
            booking_id: bookingId,
            opened_by_kind: kind,
            opened_by: userId,
            customer_id: p.customerId,
            host_account_id: p.hostAccountId,
            category: input.category,
            risk: riskOf(input.category),
            requested_outcome: input.requestedOutcome,
            status: 'OPEN',
          })
          .execute();
        await trx
          .insertInto('disputes.dispute_messages')
          .values({ dispute_id: id, author_kind: kind, author_id: userId, body: input.description })
          .execute();
        await audit.record(
          {
            actorKind: 'USER',
            actorId: userId,
            action: 'dispute.opened',
            entityKind: 'dispute',
            entityId: id,
            metadata: { bookingId, category: input.category, risk: riskOf(input.category) },
            requestId,
          },
          trx,
        );
        await events.publish('dispute.updated', { disputeId: id, bookingId, notify: [other(kind)] }, trx);
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'disputes_open_per_party_uq')
        throw disputeErrors.alreadyOpen();
      throw error;
    }
    return partyView(userId, id);
  }

  async function message(userId: string, disputeId: string, body: string, requestId: string) {
    const { d, kind } = await disputeFor(userId, disputeId);
    if (!isOpen(d.status as Status)) throw disputeErrors.closed();
    if (findContactDetails(body)) throw disputeErrors.contact();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('disputes.dispute_messages')
        .values({ dispute_id: d.id, author_kind: kind, author_id: userId, body })
        .execute();
      // A reply to "we need more information" puts the dispute back in review.
      const to = nextDisputeStatus(d.status as Status, 'PARTY_REPLIED');
      if (to)
        await trx
          .updateTable('disputes.disputes')
          .set({ status: to, version: sql<number>`version + 1` })
          .where('id', '=', d.id)
          .execute();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: userId,
          action: 'dispute.message',
          entityKind: 'dispute',
          entityId: d.id,
          requestId,
        },
        trx,
      );
    });
    await updated(d, [other(kind)]);
    return partyView(userId, disputeId);
  }

  async function addEvidence(
    actor: { userId: string; admin: boolean },
    disputeId: string,
    file: Buffer,
    requestId: string,
  ) {
    const d = await db
      .selectFrom('disputes.disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .executeTakeFirst();
    if (!d) throw errors.notFound();
    const kind: Party | 'ADMIN' = actor.admin ? 'ADMIN' : (await partyOf(actor.userId, d.booking_id)).kind;
    if (!isOpen(d.status as Status)) throw disputeErrors.closed();
    const count = await db
      .selectFrom('disputes.dispute_evidence')
      .select(sql<string>`count(*)`.as('n'))
      .where('dispute_id', '=', disputeId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_EVIDENCE) throw disputeErrors.tooMuchEvidence();
    const img = await processEvidence(file);
    const id = uuidv7();
    const key = `disputes/${disputeId}/${id}.webp`;
    await storage.put(key, img.data, 'image/webp');
    await db
      .insertInto('disputes.dispute_evidence')
      .values({
        id,
        dispute_id: disputeId,
        uploaded_by_kind: kind,
        uploaded_by: actor.userId,
        storage_key: key,
        content_type: 'image/webp',
        width: img.width,
        height: img.height,
        byte_size: img.data.length,
        sha256: img.sha256,
      })
      .execute();
    await audit.record({
      actorKind: kind === 'ADMIN' ? 'ADMIN' : 'USER',
      actorId: actor.userId,
      action: 'dispute.evidence_added',
      entityKind: 'dispute',
      entityId: disputeId,
      metadata: { evidenceId: id },
      requestId,
    });
    return { id };
  }

  /** Evidence bytes for parties and admins only (no public URLs). */
  async function evidenceFile(viewer: { userId: string; admin: boolean }, evidenceId: string) {
    const e = await db
      .selectFrom('disputes.dispute_evidence')
      .selectAll()
      .where('id', '=', evidenceId)
      .executeTakeFirst();
    if (!e) throw errors.notFound();
    if (!viewer.admin) await disputeFor(viewer.userId, e.dispute_id);
    const data = await storage.get(e.storage_key);
    if (!data) throw errors.notFound();
    return data;
  }

  async function timeline(disputeId: string, includeInternal: boolean) {
    let q = db
      .selectFrom('disputes.dispute_messages')
      .select(['author_kind', 'body', 'internal', 'created_at'])
      .where('dispute_id', '=', disputeId)
      .orderBy('id');
    if (!includeInternal) q = q.where('internal', '=', false);
    return (await q.execute()).map((m) => ({
      author: m.author_kind as Party | 'ADMIN' | 'SYSTEM',
      body: m.body,
      internal: m.internal,
      at: m.created_at,
    }));
  }

  async function evidenceList(disputeId: string) {
    const rows = await db
      .selectFrom('disputes.dispute_evidence')
      .select(['id', 'uploaded_by_kind', 'width', 'height', 'created_at'])
      .where('dispute_id', '=', disputeId)
      .orderBy('created_at')
      .execute();
    return rows.map((e) => ({
      id: e.id,
      by: e.uploaded_by_kind,
      width: e.width,
      height: e.height,
      at: e.created_at,
    }));
  }

  function base(d: Row) {
    return {
      id: d.id,
      bookingId: d.booking_id,
      openedBy: d.opened_by_kind as Party,
      category: d.category as Category,
      risk: d.risk as 'LOW' | 'HIGH',
      requestedOutcome: d.requested_outcome,
      status: d.status as Status,
      outcome: d.outcome as Outcome | null,
      refundPaise: d.refund_paise === null ? null : Number(d.refund_paise),
      resolutionNote: d.resolution_note,
      resolvedAt: d.resolved_at,
      createdAt: d.created_at,
    };
  }

  async function partyView(userId: string, disputeId: string) {
    const { d, kind } = await disputeFor(userId, disputeId);
    return {
      ...base(d),
      you: kind,
      messages: await timeline(d.id, false),
      evidence: await evidenceList(d.id),
    };
  }

  async function forBooking(userId: string, bookingId: string) {
    await partyOf(userId, bookingId);
    const rows = await db
      .selectFrom('disputes.disputes')
      .select('id')
      .where('booking_id', '=', bookingId)
      .orderBy('created_at', 'desc')
      .execute();
    return Promise.all(rows.map((r) => partyView(userId, r.id)));
  }

  // ---------------------------------------------------------------- admin (A-03)

  async function queue() {
    const rows = await db
      .selectFrom('disputes.disputes')
      .selectAll()
      .where('status', 'not in', ['RESOLVED', 'CLOSED'])
      .orderBy(sql`risk = 'HIGH'`, 'desc')
      .orderBy('created_at')
      .limit(200)
      .execute();
    return rows.map(base);
  }

  /** Everything an admin needs to decide, assembled from the systems of record (no edits possible here). */
  async function adminView(disputeId: string) {
    const d = await db
      .selectFrom('disputes.disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .executeTakeFirst();
    if (!d) throw errors.notFound();
    const [
      messages,
      evidence,
      bookingEvents,
      accessEvents,
      money,
      customerTrust,
      hostTrust,
      reviews,
      customerName,
    ] = await Promise.all([
      timeline(d.id, true),
      evidenceList(d.id),
      deps.booking.eventsOf(d.booking_id),
      deps.access.bookingAccessLog(d.booking_id),
      deps.payments.adminBookingMoney(d.booking_id),
      deps.reviews.customerTrust(d.customer_id),
      deps.reviews.hostTrust(d.host_account_id),
      deps.reviews.forAdmin(d.booking_id),
      deps.identity.customerNameForHost(d.customer_id),
    ]);
    return {
      ...base(d),
      customer: { name: customerName, trust: customerTrust },
      host: { hostAccountId: d.host_account_id, trust: hostTrust },
      messages,
      evidence,
      bookingEvents,
      accessEvents,
      money,
      reviews,
    };
  }

  async function adminAct(
    admin: { userId: string; permissions: readonly AdminPermission[] },
    disputeId: string,
    action: Exclude<AdminAction, 'PARTY_REPLIED' | 'RESOLVE'>,
    note: string | null,
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const d = await trx
        .selectFrom('disputes.disputes')
        .selectAll()
        .where('id', '=', disputeId)
        .forUpdate()
        .executeTakeFirst();
      if (!d) throw errors.notFound();
      const to = nextDisputeStatus(d.status as Status, action);
      if (!to) throw disputeErrors.transition(d.status);
      await trx
        .updateTable('disputes.disputes')
        .set({ status: to, version: sql<number>`version + 1` })
        .where('id', '=', disputeId)
        .execute();
      if (note) {
        // REQUEST_INFO notes go to the parties; others are internal.
        await trx
          .insertInto('disputes.dispute_messages')
          .values({
            dispute_id: disputeId,
            author_kind: 'ADMIN',
            author_id: admin.userId,
            body: note,
            internal: action !== 'REQUEST_INFO',
          })
          .execute();
      }
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: `dispute.${action.toLowerCase()}`,
          entityKind: 'dispute',
          entityId: disputeId,
          metadata: { to },
          requestId,
        },
        trx,
      );
      await events.publish(
        'dispute.updated',
        { disputeId, bookingId: d.booking_id, notify: ['CUSTOMER', 'HOST'] },
        trx,
      );
    });
    return adminView(disputeId);
  }

  /**
   * The decision. Admin session required (the route enforces it, and so does this signature); HIGH risk needs
   * TRUST_SAFETY (or SUPER_ADMIN). A refund outcome executes through the payments refund pipeline.
   */
  async function resolve(
    admin: { userId: string; permissions: readonly AdminPermission[] },
    disputeId: string,
    input: { outcome: Outcome; refundPaise?: number | undefined; note: string },
    requestId: string,
  ) {
    const d = await db
      .selectFrom('disputes.disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .executeTakeFirst();
    if (!d) throw errors.notFound();
    const canHighRisk =
      admin.permissions.includes('TRUST_SAFETY') || admin.permissions.includes('SUPER_ADMIN');
    if (d.risk === 'HIGH' && !canHighRisk) throw disputeErrors.highRisk();
    if (!nextDisputeStatus(d.status as Status, 'RESOLVE')) throw disputeErrors.transition(d.status);
    let refunded = 0;
    if (input.outcome === 'REFUND_FULL' || input.outcome === 'REFUND_PARTIAL') {
      const p = await deps.booking.partiesOf(d.booking_id);
      const amount =
        input.outcome === 'REFUND_FULL' ? (p?.totalPaise ?? 0) : Math.max(0, input.refundPaise ?? 0);
      refunded = (
        await deps.payments.refundForDispute({ bookingId: d.booking_id, disputeId, amountPaise: amount })
      ).refundedPaise;
    }
    await db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('disputes.disputes')
        .set({
          status: 'RESOLVED',
          outcome: input.outcome,
          refund_paise: refunded,
          resolution_note: input.note,
          resolved_by: admin.userId,
          resolved_at: new Date(now()),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', disputeId)
        .where('status', 'not in', ['RESOLVED', 'CLOSED'])
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw disputeErrors.transition('RESOLVED');
      await trx
        .insertInto('disputes.dispute_messages')
        .values({
          dispute_id: disputeId,
          author_kind: 'ADMIN',
          author_id: admin.userId,
          body: `Resolved: ${input.note}`,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: 'dispute.resolved',
          entityKind: 'dispute',
          entityId: disputeId,
          metadata: { outcome: input.outcome, refundPaise: refunded, risk: d.risk },
          requestId,
        },
        trx,
      );
      await events.publish(
        'dispute.updated',
        { disputeId, bookingId: d.booking_id, notify: ['CUSTOMER', 'HOST'] },
        trx,
      );
    });
    return adminView(disputeId);
  }

  /** BR-18: an open dispute holds the host's earnings for that booking. */
  async function hasOpenDispute(bookingId: string) {
    return !!(await db
      .selectFrom('disputes.disputes')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('status', 'not in', ['RESOLVED', 'CLOSED'])
      .executeTakeFirst());
  }

  return {
    open,
    message,
    addEvidence,
    evidenceFile,
    partyView,
    forBooking,
    queue,
    adminView,
    adminAct,
    resolve,
    hasOpenDispute,
  };
}

export type DisputeService = ReturnType<typeof createDisputeService>;
