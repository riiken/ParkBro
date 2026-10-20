import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodWindow } from '../../src/modules/booking/domain/series.ts';
import { at, bookingKit, IST, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let kit: ReturnType<typeof bookingKit>;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0 });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const MONTHLY = [
  { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
  { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
];
const start = istDay(3).set({ hour: 9 });
const monthWindow = () => [start.toISO() ?? '', start.plus({ months: 1 }).toISO() ?? ''] as const;

async function monthlyListing(seed: number, extra: Parameters<typeof kit.listing>[1] = {}) {
  return kit.listing(seed, { rates: MONTHLY, units: ['M1'], accessInstructions: 'MONTHLYSECRET', ...extra });
}

/** Requests, approves and pays period 1. */
async function activePlan(seed: number) {
  const l = await monthlyListing(seed);
  const c = await kit.customer();
  const [s, e] = monthWindow();
  const b = await kit.booked(c, l.assetId, s, e, 'MONTHLY');
  const approved = await h.post(`/api/v1/host/bookings/${b.id}/approve`, {}, { cookie: l.host.cookie });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(await h.modules.booking.confirmPayment(b.id, 'test')).toEqual({ confirmed: true });
  return { l, c, b, seriesId: b.series?.id ?? '' };
}

/** Test-only time travel: moves the plan (and period 1) so that its anchor is `anchor`. */
async function shiftPlan(seriesId: string, anchor: DateTime) {
  const w = periodWindow({ cadence: 'MONTHLY', anchorStart: anchor.toMillis(), timezone: IST }, 1);
  await kit.sql(`UPDATE booking.booking_series SET anchor_start = to_timestamp($2 / 1000.0) WHERE id = $1`, [
    seriesId,
    w.start,
  ]);
  await kit.sql(
    `UPDATE booking.bookings SET period = tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)')
     WHERE series_id = $1 AND period_index = 1`,
    [seriesId, w.start, w.end],
  );
  return w;
}

const plan = async (cookie: string, id: string, host = false) =>
  (await h.get(`/api/v1/${host ? 'host/' : ''}series/${id}`, cookie)).json();

describe('monthly request', () => {
  it('is always a request to the host and creates a plan with period 1 on one space', async () => {
    const l = await monthlyListing(1);
    const c = await kit.customer();
    const [s, e] = monthWindow();
    const q = await kit.quote(c, l.assetId, s, e, 'MONTHLY');
    expect(q.json()).toMatchObject({ approvalRequired: true, totalPaise: 300000 }); // listing itself is instant-book
    const b = await kit.booked(c, l.assetId, s, e, 'MONTHLY');
    expect(b.status).toBe('AWAITING_HOST_APPROVAL');
    expect(b.series).toMatchObject({ periodIndex: 1 });

    const mine = await h.get('/api/v1/series', c.cookie);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toHaveLength(1);
    const p = mine.json()[0];
    expect(p).toMatchObject({
      status: 'REQUESTED',
      periodPricePaise: 300000,
      noticeDays: 15,
      periods: [{ index: 1 }],
    });
    // The space label is private before confirmation (L-6); host-only fields never reach the customer.
    expect(p).not.toHaveProperty('unitLabel');
    expect(p).not.toHaveProperty('customer');
    const hostView = await plan(l.host.cookie, p.id, true);
    expect(hostView).toMatchObject({ customer: { name: 'Priya S.' }, unitLabel: 'M1' });
    // Others can't see it.
    const other = await kit.customer();
    expect((await h.get(`/api/v1/series/${p.id}`, other.cookie)).statusCode).toBe(404);
  });

  it('a declined or lapsed request ends the plan', async () => {
    const l = await monthlyListing(2, { units: ['N1', 'N2'] });
    const [a, b] = await Promise.all([kit.customer(), kit.customer()]);
    const [s, e] = monthWindow();
    const ra = await kit.booked(a, l.assetId, s, e, 'MONTHLY');
    await h.post(`/api/v1/host/bookings/${ra.id}/decline`, {}, { cookie: l.host.cookie });
    expect(await plan(a.cookie, ra.series?.id ?? '')).toMatchObject({
      status: 'ENDED',
      endedReason: 'NOT_CONFIRMED',
    });

    const rb = await kit.booked(b, l.assetId, s, e, 'MONTHLY');
    await kit.sql(
      `UPDATE booking.bookings SET approval_expires_at = now() - interval '1 second' WHERE id = $1`,
      [rb.id],
    );
    expect((await plan(b.cookie, rb.series?.id ?? '')).status).toBe('ENDED'); // reads don't wait for the job
    await h.modules.booking.seriesTick();
    const row = await kit.sql(`SELECT status, ended_reason FROM booking.booking_series WHERE id = $1`, [
      rb.series?.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'ENDED', ended_reason: 'NOT_CONFIRMED' });
  });

  it('the customer can withdraw a request, but a running plan ends by notice, not cancellation', async () => {
    const l = await monthlyListing(3);
    const c = await kit.customer();
    const [s, e] = monthWindow();
    const r = await kit.booked(c, l.assetId, s, e, 'MONTHLY');
    const withdrawn = await h.post(`/api/v1/bookings/${r.id}/cancel`, {}, { cookie: c.cookie });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(await plan(c.cookie, r.series?.id ?? '')).toMatchObject({
      status: 'ENDED',
      endedReason: 'CUSTOMER_CANCELLED',
    });

    const { c: c2, b, seriesId } = await activePlan(4);
    expect(await plan(c2.cookie, seriesId)).toMatchObject({ status: 'ACTIVE' });
    const view = (await h.get(`/api/v1/bookings/${b.id}`, c2.cookie)).json();
    expect(view.cancellation.cancellable).toBe(false);
    expect(view.access.instructions).toBe('MONTHLYSECRET');
    const refused = await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c2.cookie });
    expect(refused.json().code).toBe('booking.series_use_notice');
  });
});

describe('renewals', () => {
  it('when a period starts, the next one is held on the same space; paying keeps the plan active', async () => {
    const { l, c, seriesId } = await activePlan(5);
    const p1 = await shiftPlan(seriesId, DateTime.now().setZone(IST).minus({ days: 2 }).startOf('minute'));
    await h.modules.booking.seriesTick();
    await h.modules.booking.seriesTick(); // idempotent: no second renewal
    const periods = await kit.sql(
      `SELECT period_index, status, quote_id, total_paise::int AS total, extract(epoch FROM lower(period)) * 1000 AS s
       FROM booking.bookings WHERE series_id = $1 ORDER BY period_index`,
      [seriesId],
    );
    expect(periods.rows.map((r) => [r.period_index, r.status])).toEqual([
      [1, 'CONFIRMED'],
      [2, 'PENDING_PAYMENT'],
    ]);
    expect(periods.rows[1]).toMatchObject({ quote_id: null, total: 300000 });
    expect(Number(periods.rows[1].s)).toBe(p1.end); // contiguous, keeps the anchor day

    const view = await plan(c.cookie, seriesId);
    expect(view.periods[1]).toMatchObject({ index: 2, status: 'PENDING_PAYMENT' });
    expect(new Date(view.periods[1].payBy).getTime()).toBe(p1.end + 3 * 86_400_000); // grace
    expect(view.nextRenewal).toMatchObject({ periodIndex: 2, amountPaise: 300000 });

    // The renewal holds the space: nobody else can book into period 2.
    const other = await kit.customer();
    const into = DateTime.fromMillis(p1.end, { zone: IST }).plus({ days: 2 }).set({ hour: 10, minute: 0 });
    expect(
      (await kit.quote(other, l.assetId, into.toISO() ?? '', into.plus({ hours: 1 }).toISO() ?? '')).json()
        .code,
    ).toBe('booking.unavailable');

    const p2 = view.periods[1].bookingId as string;
    expect(await h.modules.booking.confirmPayment(p2, 'test')).toEqual({ confirmed: true });
    expect((await plan(c.cookie, seriesId)).status).toBe('ACTIVE');
    const ev = await kit.sql(`SELECT reason FROM booking.series_events WHERE series_id = $1 ORDER BY id`, [
      seriesId,
    ]);
    expect(ev.rows.map((r) => r.reason)).toEqual(['requested', 'period 1 paid', 'period 2 paid']);
  });

  it('an unpaid renewal makes the plan past due, then ends it when the grace period lapses', async () => {
    const { l, c, seriesId } = await activePlan(6);
    // Period 2 began an hour ago and the runner was down: the renewal is still created (late), then overdue.
    await shiftPlan(seriesId, DateTime.now().setZone(IST).minus({ months: 1, hours: 1 }).startOf('minute'));
    await h.modules.booking.seriesTick();
    expect((await plan(c.cookie, seriesId)).periods).toHaveLength(2);
    await h.modules.booking.seriesTick();
    expect((await plan(c.cookie, seriesId)).status).toBe('PAST_DUE');
    expect((await plan(l.host.cookie, seriesId, true)).status).toBe('PAST_DUE');

    await kit.sql(
      `UPDATE booking.bookings SET hold_expires_at = now() - interval '1 second' WHERE series_id = $1 AND period_index = 2`,
      [seriesId],
    );
    await h.modules.booking.seriesTick();
    expect(await plan(c.cookie, seriesId)).toMatchObject({
      status: 'ENDED',
      endedReason: 'RENEWAL_UNPAID',
      nextRenewal: null,
    });
  });

  it('a space that is no longer available ends the plan at the end of the current period', async () => {
    const { l, c, seriesId } = await activePlan(7);
    await shiftPlan(seriesId, DateTime.now().setZone(IST).minus({ days: 2 }).startOf('minute'));
    await kit.sql(`UPDATE assets.assets SET status = 'SUSPENDED', status_reason = 'test' WHERE id = $1`, [
      l.assetId,
    ]);
    await h.modules.booking.seriesTick();
    expect(await plan(c.cookie, seriesId)).toMatchObject({
      status: 'ENDED',
      endedReason: 'UNIT_UNAVAILABLE',
    });
  });
});

describe('notice and termination', () => {
  it('notice ends the plan at the first period boundary at least 15 days away and cancels later periods', async () => {
    const { c, seriesId } = await activePlan(8);
    const p1 = await shiftPlan(seriesId, DateTime.now().setZone(IST).minus({ days: 3 }).startOf('minute'));
    await h.modules.booking.seriesTick(); // period 2 held
    const res = await h.post(`/api/v1/series/${seriesId}/notice`, {}, { cookie: c.cookie });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'NOTICE_GIVEN', noticeBy: 'CUSTOMER', nextRenewal: null });
    expect(new Date(res.json().endsAt).getTime()).toBe(p1.end); // ~27 days left ≥ 15
    expect(res.json().periods[1].status).toBe('CANCELLED'); // the held period 2 is released
    await h.modules.booking.seriesTick();
    expect(
      (await kit.sql(`SELECT count(*)::int AS n FROM booking.bookings WHERE series_id = $1`, [seriesId]))
        .rows[0].n,
    ).toBe(2);
    // Twice is refused.
    expect((await h.post(`/api/v1/series/${seriesId}/notice`, {}, { cookie: c.cookie })).json().code).toBe(
      'series.transition_not_allowed',
    );

    // When the end passes, the job ends it.
    await kit.sql(`UPDATE booking.booking_series SET ends_at = now() - interval '1 second' WHERE id = $1`, [
      seriesId,
    ]);
    await h.modules.booking.seriesTick();
    expect(await plan(c.cookie, seriesId)).toMatchObject({ status: 'ENDED', endedReason: 'NOTICE' });
  });

  it('host notice close to a boundary runs one more period; strangers cannot give notice', async () => {
    const { l, c, seriesId } = await activePlan(9);
    const p1 = await shiftPlan(
      seriesId,
      DateTime.now().setZone(IST).minus({ months: 1 }).plus({ days: 5 }).startOf('minute'),
    );
    await h.modules.booking.seriesTick(); // period 2 held
    const stranger = await h.hostSignUp();
    expect(
      (await h.post(`/api/v1/host/series/${seriesId}/notice`, {}, { cookie: stranger.cookie })).statusCode,
    ).toBe(404);
    expect(
      (await h.post(`/api/v1/series/${seriesId}/notice`, {}, { cookie: (await kit.customer()).cookie }))
        .statusCode,
    ).toBe(404);

    const res = await h.post(`/api/v1/host/series/${seriesId}/notice`, {}, { cookie: l.host.cookie });
    expect(res.statusCode, res.body).toBe(200);
    const p2end = periodWindow({ cadence: 'MONTHLY', anchorStart: p1.start, timezone: IST }, 2).end;
    expect(new Date(res.json().endsAt).getTime()).toBe(p2end); // 5 days left < 15 → end of period 2
    expect(res.json().periods[1].status).toBe('PENDING_PAYMENT'); // period 2 still runs (and must be paid)
    expect((await plan(c.cookie, seriesId)).noticeBy).toBe('HOST');
  });

  it('a host cancelling a paid period ends the plan with full refunds', async () => {
    const { l, c, b, seriesId } = await activePlan(10);
    const res = await h.post(
      `/api/v1/host/bookings/${b.id}/cancel`,
      { reason: 'Selling the flat' },
      { cookie: l.host.cookie },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().cancellation).toMatchObject({
      refundPaise: 300000,
      cancelledBy: 'HOST',
    });
    expect(await plan(c.cookie, seriesId)).toMatchObject({ status: 'ENDED', endedReason: 'HOST_CANCELLED' });
  });

  it('notice racing a renewal payment never deadlocks', async () => {
    const { c, seriesId } = await activePlan(11);
    await shiftPlan(seriesId, DateTime.now().setZone(IST).minus({ days: 1 }).startOf('minute'));
    await h.modules.booking.seriesTick();
    const p2 = (await plan(c.cookie, seriesId)).periods[1].bookingId as string;
    const [notice, paid] = await Promise.all([
      h.post(`/api/v1/series/${seriesId}/notice`, {}, { cookie: c.cookie }),
      h.modules.booking.confirmPayment(p2, 'test'),
    ]);
    expect(notice.statusCode, notice.body).toBe(200);
    // Either order is consistent: notice ends at period 1's end, so period 2 is cancelled (refunded in full if paid).
    const row = await kit.sql(
      `SELECT status, refund_paise::int AS refund FROM booking.bookings WHERE id = $1`,
      [p2],
    );
    expect(row.rows[0].status).toBe('CANCELLED');
    expect(row.rows[0].refund).toBe(paid.confirmed ? 300000 : 0); // paid first → refunded; else payment refused
  });
});

describe('archive guard (D-071)', () => {
  it('a listing with upcoming bookings cannot be archived; pausing keeps them', async () => {
    const l = await kit.listing(12);
    const c = await kit.customer();
    const day = istDay(3);
    const b = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    const send = (path: string) =>
      h.post(`/api/v1/host/assets/${l.assetId}/${path}`, {}, { cookie: l.host.cookie });
    expect((await send('archive')).json().code).toBe('asset.has_upcoming_bookings');
    expect((await send('pause')).statusCode).toBe(200);
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('PENDING_PAYMENT');
    await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect((await send('archive')).statusCode).toBe(200);
  });
});
