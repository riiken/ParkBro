import { sql, type Kysely, type Selectable } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import { CONTACT_DETAILS_MESSAGE, findContactDetails } from '../../../platform/text/contact-details.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { IdentityModule } from '../../identity/index.ts';
import type { ReviewsDb, ReviewsTable } from '../infrastructure/tables.ts';

type Row = Selectable<ReviewsTable>;
export const REVIEW_WINDOW_DAYS = 14;
export const DIMENSIONS = [
  'accuracy',
  'communication',
  'cleanliness',
  'safety',
  'access',
  'reliability',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const reviewErrors = {
  notEligible: () =>
    new DomainError({
      code: 'review.not_eligible',
      status: 409,
      title: 'You can review only a completed booking, within 14 days',
    }),
  already: () =>
    new DomainError({
      code: 'review.already_submitted',
      status: 409,
      title: 'You already reviewed this booking',
    }),
  contact: () =>
    new DomainError({
      code: 'review.contact_details',
      status: 400,
      title: 'Remove contact details',
      detail: CONTACT_DETAILS_MESSAGE,
    }),
};

/**
 * Two-sided reviews (domain-model §5.10, trust-and-safety §8). A review stays hidden (SUBMITTED) until the other
 * side has also reviewed or the 14-day window closes, which reduces retaliation. Ratings are a trust signal, never
 * the only safety mechanism (CLAUDE.md §19).
 */
export function createReviewService(deps: {
  db: Kysely<ReviewsDb>;
  audit: AuditLog;
  booking: Pick<BookingModule, 'partiesOf' | 'customerStats' | 'hostStats'>;
  identity: Pick<IdentityModule, 'hostMemberIds' | 'customerNameForHost'>;
  now?: () => number;
}) {
  const { db, audit } = deps;
  const now = deps.now ?? Date.now;

  async function roleIn(userId: string, bookingId: string) {
    const p = await deps.booking.partiesOf(bookingId);
    if (!p) throw errors.notFound();
    if (p.customerId === userId) return { p, kind: 'CUSTOMER' as const };
    if ((await deps.identity.hostMemberIds(p.hostAccountId)).includes(userId))
      return { p, kind: 'HOST' as const };
    throw errors.notFound();
  }
  const eligible = (p: { status: string; end: number }) =>
    p.status === 'COMPLETED' && now() < p.end + REVIEW_WINDOW_DAYS * 86_400_000;

  async function submit(
    userId: string,
    bookingId: string,
    input: { rating: number; dimensions: Partial<Record<Dimension, number>>; body: string | null },
    requestId: string,
  ) {
    const { p, kind } = await roleIn(userId, bookingId);
    if (!eligible(p)) throw reviewErrors.notEligible();
    if (input.body && findContactDetails(input.body)) throw reviewErrors.contact();
    try {
      await db
        .insertInto('reviews.reviews')
        .values({
          id: uuidv7(),
          booking_id: bookingId,
          author_kind: kind,
          author_id: userId,
          asset_id: p.assetId,
          host_account_id: p.hostAccountId,
          customer_id: p.customerId,
          rating: input.rating,
          dimensions: JSON.stringify(input.dimensions),
          body: input.body,
          status: 'SUBMITTED',
        })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw reviewErrors.already();
      throw error;
    }
    // Both sides in: publish both (blind until then).
    await db
      .updateTable('reviews.reviews')
      .set({ status: 'PUBLISHED', published_at: new Date(now()) })
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'SUBMITTED')
      .where(
        sql<boolean>`(SELECT count(*) FROM reviews.reviews r2 WHERE r2.booking_id = ${bookingId} AND r2.status <> 'REMOVED') = 2`,
      )
      .execute();
    await audit.record({
      actorKind: 'USER',
      actorId: userId,
      action: 'review.submitted',
      entityKind: 'booking',
      entityId: bookingId,
      metadata: { kind, rating: input.rating },
      requestId,
    });
    return forBooking(userId, bookingId);
  }

  /** Job: reviews whose window closed are published even if the other side never wrote one. */
  async function publishDue(): Promise<number> {
    const rows = await db
      .selectFrom('reviews.reviews')
      .select(['id', 'booking_id'])
      .where('status', '=', 'SUBMITTED')
      .limit(500)
      .execute();
    let n = 0;
    for (const r of rows) {
      const p = await deps.booking.partiesOf(r.booking_id);
      if (!p || now() < p.end + REVIEW_WINDOW_DAYS * 86_400_000) continue;
      await db
        .updateTable('reviews.reviews')
        .set({ status: 'PUBLISHED', published_at: new Date(now()) })
        .where('id', '=', r.id)
        .where('status', '=', 'SUBMITTED')
        .execute();
      n += 1;
    }
    return n;
  }

  const view = (r: Row) => ({
    rating: r.rating,
    dimensions: r.dimensions as Partial<Record<Dimension, number>>,
    body: r.body,
    status: r.status as 'SUBMITTED' | 'PUBLISHED' | 'REMOVED',
    createdAt: r.created_at,
  });

  /** The participant's view: their own review, and the other side's only once published. */
  async function forBooking(userId: string, bookingId: string) {
    const { p, kind } = await roleIn(userId, bookingId);
    const rows = await db
      .selectFrom('reviews.reviews')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .execute();
    const mine = rows.find((r) => r.author_kind === kind);
    const theirs = rows.find((r) => r.author_kind !== kind && r.status === 'PUBLISHED');
    return {
      canReview: !mine && eligible(p),
      windowEndsAt: new Date(p.end + REVIEW_WINDOW_DAYS * 86_400_000),
      mine: mine ? view(mine) : null,
      theirs: theirs ? view(theirs) : null,
    };
  }

  /** Public listing reviews (customer → listing), published only. */
  async function listingReviews(assetId: string) {
    const rows = await db
      .selectFrom('reviews.reviews')
      .selectAll()
      .where('asset_id', '=', assetId)
      .where('author_kind', '=', 'CUSTOMER')
      .where('status', '=', 'PUBLISHED')
      .orderBy('published_at', 'desc')
      .limit(50)
      .execute();
    const agg = await db
      .selectFrom('reviews.reviews')
      .select([sql<string>`count(*)`.as('n'), sql<string>`coalesce(avg(rating), 0)`.as('avg')])
      .where('asset_id', '=', assetId)
      .where('author_kind', '=', 'CUSTOMER')
      .where('status', '=', 'PUBLISHED')
      .executeTakeFirstOrThrow();
    const dims: Partial<Record<Dimension, number>> = {};
    for (const d of DIMENSIONS) {
      const vals = rows
        .map((r) => (r.dimensions as Record<string, number>)[d])
        .filter((v): v is number => typeof v === 'number');
      if (vals.length) dims[d] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }
    return {
      count: Number(agg.n),
      // Shown only with at least 3 reviews (a single rating is noise).
      average: Number(agg.n) >= 3 ? Math.round(Number(agg.avg) * 10) / 10 : null,
      dimensions: Number(agg.n) >= 3 ? dims : {},
      items: await Promise.all(
        rows.map(async (r) => ({
          rating: r.rating,
          body: r.body,
          author: await deps.identity.customerNameForHost(r.customer_id),
          month: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
            r.published_at ?? r.created_at,
          ),
        })),
      ),
    };
  }

  /** What a host sees about a customer on a request (H-06): verification, history, host ratings. No contact data. */
  async function customerTrust(customerId: string) {
    const [stats, agg] = await Promise.all([
      deps.booking.customerStats(customerId),
      db
        .selectFrom('reviews.reviews')
        .select([sql<string>`count(*)`.as('n'), sql<string>`coalesce(avg(rating), 0)`.as('avg')])
        .where('customer_id', '=', customerId)
        .where('author_kind', '=', 'HOST')
        .where('status', '=', 'PUBLISHED')
        .executeTakeFirstOrThrow(),
    ]);
    return {
      phoneVerified: true, // every account signs in with an OTP (V-PHONE)
      completedBookings: stats.completed,
      noShows: stats.noShows,
      hostRating: Number(agg.n) >= 3 ? Math.round(Number(agg.avg) * 10) / 10 : null,
      hostRatingCount: Number(agg.n),
    };
  }

  async function customerTrustForBooking(bookingId: string) {
    const p = await deps.booking.partiesOf(bookingId);
    if (!p) throw errors.notFound();
    return customerTrust(p.customerId);
  }

  async function hostTrust(hostAccountId: string) {
    const stats = await deps.booking.hostStats(hostAccountId);
    return { completedBookings: stats.completed, hostCancellations90d: stats.hostCancellations90d };
  }

  async function remove(adminId: string, reviewId: string, reason: string, requestId: string) {
    const res = await db
      .updateTable('reviews.reviews')
      .set({ status: 'REMOVED', removed_reason: reason })
      .where('id', '=', reviewId)
      .where('status', '<>', 'REMOVED')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
    await audit.record({
      actorKind: 'ADMIN',
      actorId: adminId,
      action: 'review.removed',
      entityKind: 'review',
      entityId: reviewId,
      metadata: { reason },
      requestId,
    });
  }

  async function adminList(f: {
    status?: string | undefined;
    authorKind?: string | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('reviews.reviews');
    if (f.status) q = q.where('status', '=', f.status);
    if (f.authorKind) q = q.where('author_kind', '=', f.authorKind);
    const [rows, total] = await Promise.all([
      q.selectAll().orderBy('created_at', 'desc').offset(f.offset).limit(f.limit).execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        bookingId: r.booking_id,
        assetId: r.asset_id,
        authorKind: r.author_kind,
        ...view(r),
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  async function forAdmin(bookingId: string) {
    const rows = await db
      .selectFrom('reviews.reviews')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .execute();
    return rows.map((r) => ({ id: r.id, authorKind: r.author_kind, ...view(r) }));
  }

  return {
    submit,
    publishDue,
    forBooking,
    listingReviews,
    customerTrust,
    customerTrustForBooking,
    hostTrust,
    remove,
    forAdmin,
    adminList,
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
