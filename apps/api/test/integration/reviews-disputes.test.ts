import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';
import { jpegWithGps } from './helpers/images.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let support: string;
let kit: ReturnType<typeof bookingKit>;
const pay = fakeProvider();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: pay });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  support = await h.adminSignIn(['SUPPORT']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

type Listing = Awaited<ReturnType<typeof kit.listing>>;
type Customer = Awaited<ReturnType<typeof kit.customer>>;

/** A paid booking (₹120 = 3 h), optionally moved so that it ended `endedHoursAgo` hours ago and completed. */
async function paid(
  l: Listing,
  opts: { endedHoursAgo?: number; startedMinutesAgo?: number; start?: string } = {},
) {
  const c = await kit.customer();
  const day = istDay(3);
  const start = opts.start ?? '10:00';
  const end = `${String(Number(start.slice(0, 2)) + 3).padStart(2, '0')}:${start.slice(3)}`;
  const b = await kit.booked(c, l.assetId, at(day, start), at(day, end));
  const p = (
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${b.id}/payments`,
      headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
    })
  ).json();
  const hook = pay.simulate(p.checkout.orderId, 'captured');
  await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
  if (opts.endedHoursAgo !== undefined) {
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - make_interval(hours => $2 + 3), now() - make_interval(hours => $2), '[)') WHERE id = $1`,
      [b.id, opts.endedHoursAgo],
    );
    await h.modules.booking.completeFinished();
  } else if (opts.startedMinutesAgo !== undefined) {
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - make_interval(mins => $2), now() + interval '2 hours', '[)') WHERE id = $1`,
      [b.id, opts.startedMinutesAgo],
    );
  }
  return { c, b };
}

const review = (cookie: string, bookingId: string, body: object) =>
  h.post(`/api/v1/bookings/${bookingId}/review`, body, { cookie });

describe('reviews', () => {
  it('are blind until both sides review, then published; listing shows them', async () => {
    const l = await kit.listing(1, { units: ['R1', 'R2', 'R3'] });
    const { c, b } = await paid(l, { endedHoursAgo: 2 });
    const mine = await review(c.cookie, b.id, {
      rating: 5,
      dimensions: { accuracy: 5, access: 4 },
      body: 'Easy to find and safe.',
    });
    expect(mine.statusCode, mine.body).toBe(201);
    expect(mine.json()).toMatchObject({
      canReview: false,
      mine: { rating: 5, status: 'SUBMITTED' },
      theirs: null,
    });
    const hostSide = (await h.get(`/api/v1/bookings/${b.id}/review`, l.host.cookie)).json();
    expect(hostSide).toMatchObject({ canReview: true, mine: null, theirs: null }); // blind
    expect((await h.get(`/api/v1/listings/${l.assetId}/reviews`)).json().count).toBe(0);

    const hostReview = await review(l.host.cookie, b.id, { rating: 4, body: 'Punctual.' });
    expect(hostReview.json()).toMatchObject({
      mine: { status: 'PUBLISHED' },
      theirs: { rating: 5, status: 'PUBLISHED' },
    });
    const pub = (await h.get(`/api/v1/listings/${l.assetId}/reviews`)).json();
    expect(pub).toMatchObject({
      count: 1,
      average: null,
      items: [{ rating: 5, body: 'Easy to find and safe.', author: 'Priya S.' }],
    });

    expect((await review(c.cookie, b.id, { rating: 3 })).json().code).toBe('review.already_submitted');
    const stranger = await kit.customer();
    expect((await review(stranger.cookie, b.id, { rating: 1 })).statusCode).toBe(404);
  });

  it('only completed bookings within 14 days; no contact details; window close publishes', async () => {
    const l = await kit.listing(2, { units: ['R1', 'R2'] });
    const active = await paid(l);
    expect((await review(active.c.cookie, active.b.id, { rating: 4 })).json().code).toBe(
      'review.not_eligible',
    );
    const { c, b } = await paid(l, { endedHoursAgo: 2, start: '14:00' });
    expect((await review(c.cookie, b.id, { rating: 4, body: 'Call me on 9876543210' })).json().code).toBe(
      'review.contact_details',
    );
    await review(c.cookie, b.id, { rating: 2, body: 'Gate was locked.' });
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '16 days', now() - interval '15 days', '[)') WHERE id = $1`,
      [b.id],
    );
    expect(await h.modules.reviews.publishDue()).toBeGreaterThanOrEqual(1);
    expect((await h.get(`/api/v1/listings/${l.assetId}/reviews`)).json().count).toBe(1);
    expect((await review(l.host.cookie, b.id, { rating: 5 })).json().code).toBe('review.not_eligible'); // window closed
  });

  it('averages appear from 3 reviews; hosts see customer trust signals; admins can remove a review', async () => {
    const l = await kit.listing(3, { units: ['A', 'B', 'C', 'D'] });
    const ids: string[] = [];
    for (const [i, start] of ['06:00', '09:00', '12:00'].entries()) {
      const { c, b } = await paid(l, { endedHoursAgo: 2 + i * 4, start });
      await review(c.cookie, b.id, { rating: 3 + i, dimensions: { cleanliness: 4 } });
      await review(l.host.cookie, b.id, { rating: 5 });
      ids.push(b.id);
    }
    const pub = (await h.get(`/api/v1/listings/${l.assetId}/reviews`)).json();
    expect(pub).toMatchObject({ count: 3, average: 4, dimensions: { cleanliness: 4 } });
    const trust = (await h.get(`/api/v1/host/bookings/${ids[0]}/customer-trust`, l.host.cookie)).json();
    expect(trust).toMatchObject({
      phoneVerified: true,
      completedBookings: 1,
      noShows: 0,
      hostRating: null,
      hostRatingCount: 1,
    });
    const other = await h.hostSignUp();
    expect((await h.get(`/api/v1/host/bookings/${ids[0]}/customer-trust`, other.cookie)).statusCode).toBe(
      404,
    );

    const reviewId = (
      await kit.sql(`SELECT id FROM reviews.reviews WHERE booking_id = $1 AND author_kind = 'CUSTOMER'`, [
        ids[0],
      ])
    ).rows[0].id;
    expect(
      (
        await h.post(
          `/api/admin/v1/reviews/${reviewId}/remove`,
          { reason: 'Abusive language' },
          { cookie: support },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.post(
          `/api/admin/v1/reviews/${reviewId}/remove`,
          { reason: 'Abusive language' },
          { cookie: admin },
        )
      ).statusCode,
    ).toBe(204);
    expect((await h.get(`/api/v1/listings/${l.assetId}/reviews`)).json().count).toBe(2);
  });
});

describe('disputes', () => {
  const open = (cookie: string, bookingId: string, body: object) =>
    h.post(`/api/v1/bookings/${bookingId}/disputes`, body, { cookie });

  it('a party opens a dispute with a timeline and photo evidence; others see nothing', async () => {
    const l = await kit.listing(4, { units: ['D1', 'D2'] });
    const future = await paid(l);
    expect(
      (
        await open(future.c.cookie, future.b.id, {
          category: 'ACCESS_FAILURE',
          description: 'x',
          requestedOutcome: 'REFUND',
        })
      ).json().code,
    ).toBe('dispute.not_allowed');
    const { c, b } = await paid(l, { startedMinutesAgo: 30, start: '14:00' });
    const res = await open(c.cookie, b.id, {
      category: 'ACCESS_FAILURE',
      description: 'The gate stayed locked for 40 minutes.',
      requestedOutcome: 'REFUND',
    });
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json();
    expect(d).toMatchObject({
      category: 'ACCESS_FAILURE',
      risk: 'LOW',
      status: 'OPEN',
      you: 'CUSTOMER',
      messages: [{ author: 'CUSTOMER' }],
    });
    expect(
      (
        await open(c.cookie, b.id, { category: 'BILLING', description: 'again', requestedOutcome: 'OTHER' })
      ).json().code,
    ).toBe('dispute.already_open');
    expect(
      (
        await open(c.cookie, b.id, {
          category: 'BILLING',
          description: 'Mail me at a@b.com',
          requestedOutcome: 'OTHER',
        })
      ).statusCode,
    ).toBe(400);

    const reply = await h.post(
      `/api/v1/disputes/${d.id}/messages`,
      { body: 'Sorry, the guard had the wrong list.' },
      { cookie: l.host.cookie },
    );
    expect(reply.json().messages.map((m: { author: string }) => m.author)).toEqual(['CUSTOMER', 'HOST']);

    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/v1/disputes/${d.id}/evidence`,
      headers: { ...CSRF, cookie: c.cookie, 'content-type': 'image/jpeg' },
      payload: await jpegWithGps(),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const file = await h.app.inject({
      method: 'GET',
      url: `/api/v1/dispute-evidence/${upload.json().id}`,
      headers: { cookie: l.host.cookie },
    });
    expect(file.headers['content-type']).toBe('image/webp');
    expect((await sharp(file.rawPayload).metadata()).exif).toBeUndefined(); // GPS stripped
    const stranger: Customer = await kit.customer();
    expect((await h.get(`/api/v1/disputes/${d.id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await h.get(`/api/v1/dispute-evidence/${upload.json().id}`, stranger.cookie)).statusCode).toBe(
      404,
    );
    const notified = await kit.sql(
      `SELECT count(*)::int AS n FROM notifications.notifications WHERE template = 'dispute.update' AND user_id = $1`,
      [l.host.userId],
    );
    expect(notified.rows[0].n).toBeGreaterThan(0);
  });

  it('admins see the evidence pack and resolve; a partial refund goes through payments', async () => {
    const l = await kit.listing(5, { units: ['E1'] });
    const { c, b } = await paid(l, { endedHoursAgo: 2 });
    const d = (
      await open(c.cookie, b.id, {
        category: 'INCORRECT_LISTING',
        description: 'It was not covered as listed.',
        requestedOutcome: 'PARTIAL_REFUND',
      })
    ).json();
    const view = (await h.get(`/api/admin/v1/disputes/${d.id}`, support)).json();
    expect(view.bookingEvents.map((e: { to: string }) => e.to)).toEqual(
      expect.arrayContaining(['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED']),
    );
    expect(view.money.payments[0]).toMatchObject({ status: 'SUCCEEDED', amountPaise: 12000 });
    expect(view.customer.trust).toMatchObject({ completedBookings: 1 });
    expect(view.accessEvents.map((e: { kind: string }) => e.kind)).toContain('ISSUED');

    const info = await h.post(
      `/api/admin/v1/disputes/${d.id}/request-info`,
      { note: 'Please share a photo of the spot.' },
      { cookie: support },
    );
    expect(info.json().status).toBe('AWAITING_INFO');
    expect((await h.get(`/api/v1/disputes/${d.id}`, c.cookie)).json().messages.at(-1)).toMatchObject({
      author: 'ADMIN',
      body: 'Please share a photo of the spot.',
    });
    await h.post(`/api/v1/disputes/${d.id}/messages`, { body: 'Photo attached.' }, { cookie: c.cookie });
    expect((await h.get(`/api/admin/v1/disputes/${d.id}`, support)).json().status).toBe('UNDER_REVIEW');
    await h.post(
      `/api/admin/v1/disputes/${d.id}/review`,
      { note: 'Internal: host photos show an open bay.' },
      { cookie: support },
    );
    expect(JSON.stringify((await h.get(`/api/v1/disputes/${d.id}`, c.cookie)).json())).not.toContain(
      'Internal:',
    );

    const resolved = await h.post(
      `/api/admin/v1/disputes/${d.id}/resolve`,
      { outcome: 'REFUND_PARTIAL', refundPaise: 3000, note: 'Listing said covered; 25% refund.' },
      { cookie: support },
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: 'RESOLVED',
      outcome: 'REFUND_PARTIAL',
      refundPaise: 3000,
    });
    const refund = await kit.sql(
      `SELECT reason, amount_paise::int AS a, idempotency_key FROM payments.refunds WHERE booking_id = $1`,
      [b.id],
    );
    expect(refund.rows).toEqual([{ reason: 'DISPUTE', a: 3000, idempotency_key: `dispute:${d.id}` }]);
    expect(
      (await h.post(`/api/v1/disputes/${d.id}/messages`, { body: 'More' }, { cookie: c.cookie })).json().code,
    ).toBe('dispute.closed');
    expect(
      (await h.post(`/api/admin/v1/disputes/${d.id}/close`, {}, { cookie: support })).json().status,
    ).toBe('CLOSED');
    const audit = await kit.sql(`SELECT action FROM platform.audit_events WHERE entity_id = $1 ORDER BY id`, [
      d.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['dispute.opened', 'dispute.request_info', 'dispute.resolved', 'dispute.close']),
    );
  });

  it('high-risk disputes are resolved only by trust & safety; refunds never exceed what is left', async () => {
    const l = await kit.listing(6, { units: ['F1'] });
    const { c, b } = await paid(l, { endedHoursAgo: 2 });
    const damage = (
      await open(l.host.cookie, b.id, {
        category: 'DAMAGE',
        description: 'Car scraped the gate pillar.',
        requestedOutcome: 'COMPENSATION',
      })
    ).json();
    expect(damage).toMatchObject({ risk: 'HIGH', you: 'HOST' });
    const queue = (await h.get('/api/admin/v1/disputes', support)).json();
    expect(queue[0]).toMatchObject({ risk: 'HIGH' });
    expect(
      (
        await h.post(
          `/api/admin/v1/disputes/${damage.id}/resolve`,
          { outcome: 'NO_ACTION', note: 'No evidence.' },
          { cookie: support },
        )
      ).json().code,
    ).toBe('dispute.trust_safety_only');
    expect(
      (
        await h.post(
          `/api/admin/v1/disputes/${damage.id}/resolve`,
          { outcome: 'WARNING', note: 'Warned the customer.' },
          { cookie: admin },
        )
      ).json().status,
    ).toBe('RESOLVED');
    // Customers can't resolve (no admin session).
    const theirs = (
      await open(c.cookie, b.id, {
        category: 'BILLING',
        description: 'Charged twice?',
        requestedOutcome: 'REFUND',
      })
    ).json();
    expect(
      (
        await h.post(
          `/api/admin/v1/disputes/${theirs.id}/resolve`,
          { outcome: 'REFUND_FULL', note: 'x' },
          { cookie: c.cookie },
        )
      ).statusCode,
    ).toBe(401);
    await h.post(
      `/api/admin/v1/disputes/${theirs.id}/resolve`,
      { outcome: 'REFUND_PARTIAL', refundPaise: 10000, note: 'Goodwill.' },
      { cookie: support },
    );
    const second = (
      await open(c.cookie, b.id, {
        category: 'BILLING',
        description: 'Still wrong.',
        requestedOutcome: 'REFUND',
      })
    ).json();
    const r = await h.post(
      `/api/admin/v1/disputes/${second.id}/resolve`,
      { outcome: 'REFUND_FULL', note: 'Refund the rest.' },
      { cookie: support },
    );
    expect(r.json().refundPaise).toBe(2000); // 12000 captured − 10000 already refunded
  });

  it('an open dispute holds the host earnings release until it is resolved', async () => {
    const l = await kit.listing(7, { units: ['H1'] });
    const { c, b } = await paid(l, { endedHoursAgo: 60 });
    const d = (
      await open(c.cookie, b.id, {
        category: 'NO_SHOW',
        description: 'I was there, the host marked wrongly.',
        requestedOutcome: 'REVIEW_ONLY',
      })
    ).json();
    await h.modules.earnings.releaseEarnings();
    const held = (await h.get('/api/v1/host/earnings', l.host.cookie)).json().balances;
    expect(held).toMatchObject({ pendingPaise: 10800, availablePaise: 0 });
    await h.post(
      `/api/admin/v1/disputes/${d.id}/resolve`,
      { outcome: 'NO_ACTION', note: 'Booking was fine.' },
      { cookie: support },
    );
    await h.modules.earnings.releaseEarnings();
    expect((await h.get('/api/v1/host/earnings', l.host.cookie)).json().balances).toMatchObject({
      pendingPaise: 0,
      availablePaise: 10800,
    });
  });
});
