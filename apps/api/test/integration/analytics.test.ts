import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetricsService } from '../../src/modules/analytics/application/metrics-service.ts';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { createDb } from '../../src/platform/db/database.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, randomIp, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let trust: string;
let kit: ReturnType<typeof bookingKit>;
const pay = fakeProvider();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: pay });
  trust = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => trust, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const search = (lat: number, lng: number) =>
  h.app.inject({
    method: 'GET',
    url: `/api/v1/listings/search?lat=${lat}&lng=${lng}&type=PARKING`,
    remoteAddress: randomIp(),
  });

async function paid(c: Awaited<ReturnType<typeof kit.customer>>, bookingId: string) {
  const p = (
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${bookingId}/payments`,
      headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
    })
  ).json();
  const hook = pay.simulate(p.checkout.orderId, 'captured');
  await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
}

describe('analytics', () => {
  it('records anonymous discovery signals and reports supply, demand, marketplace and liquidity', async () => {
    expect((await search(12.9352, 77.6245)).json().results).toHaveLength(0); // before any supply
    const l = await kit.listing(1, { units: ['P1'] });
    expect((await search(12.9352, 77.6245)).json().results).toHaveLength(1);
    await search(12.9352, 77.6245);
    await search(19.076, 72.8777); // Mumbai: no supply
    for (let i = 0; i < 2; i += 1) {
      const view = await h.app.inject({ method: 'GET', url: `/api/v1/listings/${l.assetId}` });
      expect(view.statusCode).toBe(200);
    }

    const stored = await kit.sql(`SELECT * FROM analytics.search_events ORDER BY id`);
    expect(stored.rows.map((r) => [r.cell, r.result_count, r.area_label])).toEqual([
      ['12.94,77.62', 0, null],
      ['12.94,77.62', 1, 'Koramangala'],
      ['12.94,77.62', 1, 'Koramangala'],
      ['19.08,72.88', 0, null],
    ]);
    // Nothing that identifies a person is stored (D-159).
    expect(Object.keys(stored.rows[0])).toEqual([
      'id',
      'at',
      'cell',
      'area_label',
      'asset_type',
      'mode',
      'windowed',
      'result_count',
      'first_page',
    ]);

    const c = await kit.customer();
    const b1 = await kit.booked(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '12:00'));
    await paid(c, b1.id);
    const b2 = await kit.booked(c, l.assetId, at(istDay(3), '14:00'), at(istDay(3), '15:00'));
    await paid(c, b2.id);
    const cancel = await h.post(`/api/v1/bookings/${b2.id}/cancel`, {}, { cookie: c.cookie });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await kit.booked(c, l.assetId, at(istDay(3), '18:00'), at(istDay(3), '19:00')); // never paid

    const totals = (
      await kit.sql(`SELECT sum(total_paise)::int AS t FROM booking.bookings WHERE id = ANY($1)`, [
        [b1.id, b2.id],
      ])
    ).rows[0].t as number;

    // Seen from after the bookings ran, so their hours fall inside the window.
    const later = createMetricsService({
      db: createDb(db.pool) as never,
      now: () => Date.parse(at(istDay(5), '00:00')),
    });
    const o = await later.overview(30);
    expect(o.supply.hosts).toMatchObject({ total: 1, live: 1, withBookings: 1 });
    const parking = o.supply.byType.find((t) => t.assetType === 'PARKING');
    expect(parking).toEqual({
      assetType: 'PARKING',
      publishedListings: 1,
      activeUnits: 1,
      openUnitHours: 720, // 24/7 × 30 days × 1 unit
      bookedUnitHours: 2, // the cancelled and unpaid bookings did not occupy the unit
      utilisation: 0.0028,
    });
    expect(o.demand).toMatchObject({
      customers: { withBookings: 1 },
      searches: { total: 4, zeroResult: 2, zeroResultRate: 0.5, withTimeWindow: 0 },
      listingViews: 2,
      bookings: { requested: 3, confirmed: 2, successRate: 0.6667 },
      conversion: { searchToBooking: 0.5, viewToBooking: 1 },
      repeatCustomers: 1,
      repeatRate: 1,
    });
    expect(o.marketplace).toMatchObject({
      gmvPaise: totals,
      averageBookingValuePaise: Math.round(totals / 2),
      cancellation: { rate: 0.5, byCustomer: 1, byHost: 0, byPlatform: 0 },
      noShowRate: null,
      retention: { hosts: null, customers: null },
    });
    expect(o.marketplace.netGmvPaise).toBe(totals - o.marketplace.refundsPaise);
    expect(o.marketplace.platformRevenuePaise).toBe(
      o.marketplace.commissionPaise + o.marketplace.serviceFeePaise,
    );
    expect(o.marketplace.commissionPaise).toBeGreaterThan(0);
    expect(o.daily).toHaveLength(31);
    expect(o.daily.reduce((s, d) => s + d.searches, 0)).toBe(4);
    expect(o.daily.reduce((s, d) => s + d.confirmedBookings, 0)).toBe(2);
    expect(o.daily.reduce((s, d) => s + d.gmvPaise, 0)).toBe(totals);

    const liq = await later.liquidity(30, 'PARKING');
    expect(liq.areas.find((a) => a.cell === '19.08,72.88')).toEqual({
      cell: '19.08,72.88',
      areaLabel: null,
      searches: 1,
      zeroResultSearches: 1,
      zeroResultRate: 1,
      publishedListings: 0,
      confirmedBookings: 0,
    });
    const supplied = liq.areas.filter((a) => a.publishedListings > 0);
    expect(supplied).toHaveLength(1);
    expect(supplied[0]).toMatchObject({ areaLabel: 'Koramangala', confirmedBookings: 2 });
    expect((await later.liquidity(30, 'EV_CHARGING')).areas).toEqual([]);
  });

  it('is served to admins only and validates the window', async () => {
    const customer = await kit.customer();
    const support = await h.adminSignIn(['SUPPORT']);
    expect((await h.get('/api/admin/v1/analytics/overview', customer.cookie)).statusCode).toBe(401);
    expect((await h.get('/api/admin/v1/analytics/liquidity', customer.cookie)).statusCode).toBe(401);
    const res = await h.get('/api/admin/v1/analytics/overview?days=7', support);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ window: { days: 7 }, demand: { searches: { total: 4 } } });
    expect(res.body).not.toMatch(/phone|\+91|exact/i);
    expect((await h.get('/api/admin/v1/analytics/overview?days=400', support)).statusCode).toBe(400);
    expect((await h.get('/api/admin/v1/analytics/liquidity?type=PARKING', support)).statusCode).toBe(200);
  });

  it('purges events past the retention period', async () => {
    await kit.sql(`INSERT INTO analytics.search_events (at, cell, asset_type, windowed, result_count, first_page)
      VALUES (now() - interval '401 days', '12.94,77.62', 'PARKING', false, 0, true)`);
    expect(await h.modules.analytics.purgeOldEvents()).toBe(1);
    expect((await kit.sql(`SELECT count(*)::int AS n FROM analytics.search_events`)).rows[0].n).toBe(4);
  });
});
