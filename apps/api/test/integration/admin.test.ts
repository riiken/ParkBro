import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, randomIp, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let trust: string;
let support: string;
let finance: string;
let kit: ReturnType<typeof bookingKit>;
const pay = fakeProvider();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: pay });
  trust = await h.adminSignIn(['TRUST_SAFETY']);
  support = await h.adminSignIn(['SUPPORT']);
  finance = await h.adminSignIn(['FINANCE']);
  kit = bookingKit(h, () => trust, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const get = (url: string, cookie: string) => h.get(`/api/admin${url}`, cookie);
const post = (url: string, body: object, cookie: string) => h.post(`/api/admin${url}`, body, { cookie });

describe('authorization', () => {
  it('every admin endpoint needs an admin session with the right permission', async () => {
    const customer = await kit.customer();
    for (const url of [
      '/v1/users',
      '/v1/bookings',
      '/v1/payments',
      '/v1/audit',
      '/v1/fraud-indicators',
      '/v1/config',
      '/v1/assets',
      '/v1/properties',
      '/v1/reviews',
      '/v1/payouts',
      '/v1/hosts',
    ]) {
      expect((await get(url, customer.cookie)).statusCode, url).toBe(401);
    }
    expect((await get('/v1/payments', support)).statusCode).toBe(403);
    expect((await get('/v1/payments', finance)).statusCode).toBe(200);
    expect((await get('/v1/audit', support)).statusCode).toBe(403);
    expect((await get('/v1/fraud-indicators', finance)).statusCode).toBe(403);
    expect((await get('/v1/config', finance)).statusCode).toBe(200);
  });
});

describe('users and hosts', () => {
  it('search by exact phone or name; suspension revokes sessions and is audited', async () => {
    const c = await kit.customer();
    const byPhone = (await get(`/v1/users?q=${c.phone}`, support)).json();
    expect(byPhone).toMatchObject({
      total: 1,
      items: [
        {
          id: c.userId,
          phoneMasked: `+91 ••••••${c.phone.slice(-4)}`,
          status: 'ACTIVE',
          roles: ['CUSTOMER'],
        },
      ],
    });
    expect(JSON.stringify(byPhone)).not.toContain(c.phone);
    expect((await get('/v1/users?q=Priya&limit=2', support)).json()).toMatchObject({ limit: 2 });
    const detail = (await get(`/v1/users/${c.userId}`, support)).json();
    expect(detail.activeSessions).toBeGreaterThanOrEqual(1);

    expect(
      (await post(`/v1/users/${c.userId}/suspend`, { reason: 'Fraud report' }, support)).statusCode,
    ).toBe(403);
    expect((await post(`/v1/users/${c.userId}/suspend`, { reason: 'x' }, trust)).statusCode).toBe(400); // reason required
    expect(
      (await post(`/v1/users/${c.userId}/suspend`, { reason: 'Fraud report from a host' }, trust)).statusCode,
    ).toBe(204);
    expect((await h.get('/api/v1/me', c.cookie)).statusCode).toBe(401);
    expect((await get(`/v1/users/${c.userId}`, support)).json().status).toBe('SUSPENDED');
    expect(
      (await post(`/v1/users/${c.userId}/reinstate`, { reason: 'Report was mistaken' }, trust)).statusCode,
    ).toBe(204);
    const audit = (await get(`/v1/audit?entityKind=user&entityId=${c.userId}`, trust)).json();
    expect(
      audit.items.map((e: { action: string }) => e.action).filter((a: string) => /suspend|reinstate/.test(a)),
    ).toEqual(['user.reinstate', 'user.suspend']);
    expect(audit.items.find((e: { action: string }) => e.action === 'user.suspend').metadata).toMatchObject({
      reason: 'Fraud report from a host',
    });
  });

  it('restricting a host hides their listings from discovery', async () => {
    const l = await kit.listing(1);
    const search = async () =>
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/v1/listings/search?lat=12.9352&lng=77.6245&type=PARKING`,
          remoteAddress: randomIp(),
        })
      )
        .json()
        .results.map((r: { id: string }) => r.id);
    expect(await search()).toContain(l.assetId);
    const hosts = (await get('/v1/hosts?q=Host 1', support)).json();
    expect(hosts.items.map((x: { id: string }) => x.id)).toContain(l.host.hostAccountId);
    expect(
      (
        await post(
          `/v1/hosts/${l.host.hostAccountId}/status`,
          { status: 'RESTRICTED', reason: 'Repeated complaints' },
          trust,
        )
      ).statusCode,
    ).toBe(204);
    expect(await search()).not.toContain(l.assetId);
    await post(
      `/v1/hosts/${l.host.hostAccountId}/status`,
      { status: 'ACTIVE', reason: 'Resolved with the host' },
      trust,
    );
    expect(await search()).toContain(l.assetId);
  });
});

describe('bookings, money and listings', () => {
  it('bookings can be filtered, inspected with history and cancelled by support with a full refund', async () => {
    const l = await kit.listing(2, { units: ['B1'], asset: { cancellationPolicy: 'STRICT' } });
    const c = await kit.customer();
    const b = await kit.booked(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '12:00'));
    const p = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${b.id}/payments`,
        headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
      })
    ).json();
    const hook = pay.simulate(p.checkout.orderId, 'captured');
    await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');

    const list = (await get(`/v1/bookings?status=CONFIRMED&customerId=${c.userId}`, support)).json();
    expect(list).toMatchObject({ total: 1, items: [{ id: b.id, totalPaise: 8000 }] });
    expect((await get(`/v1/bookings?q=${b.id.slice(0, 13)}`, support)).json().items[0].id).toBe(b.id);
    const detail = (await get(`/v1/bookings/${b.id}`, support)).json();
    expect(detail.events.map((e: { to: string }) => e.to)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
    const cancelled = await post(
      `/v1/bookings/${b.id}/cancel`,
      { reason: 'Host reported a burst water pipe' },
      support,
    );
    expect(cancelled.json()).toEqual({ refundPaise: 8000 }); // platform cancellation refunds in full regardless of policy
    const refunds = (await get('/v1/refunds?status=PENDING', finance)).json();
    expect(refunds.items.find((r: { bookingId: string }) => r.bookingId === b.id)).toMatchObject({
      reason: 'PLATFORM_CANCELLED',
      amountPaise: 8000,
    });
    expect((await get(`/v1/payments?bookingId=${b.id}`, finance)).json().items[0]).toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('lists for properties, listings, reviews and payouts filter and paginate', async () => {
    const l3 = await kit.listing(3);
    // Opening a property's exact address is an audited PII reveal (R-56).
    const detail = await get(`/properties/${l3.propertyId}`, trust);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().address).toContain('Test Street');
    const reveals = (await get(`/v1/audit?entityKind=property&entityId=${l3.propertyId}`, trust)).json();
    expect(reveals.items.map((e: { action: string }) => e.action)).toContain('property.address_viewed');
    const assets = (await get('/v1/assets?status=PUBLISHED&limit=1', support)).json();
    expect(assets.items).toHaveLength(1);
    expect(assets.total).toBeGreaterThanOrEqual(2);
    const page2 = (await get('/v1/assets?status=PUBLISHED&limit=1&offset=1', support)).json();
    expect(page2.items[0].id).not.toBe(assets.items[0].id);
    expect((await get('/v1/properties?kind=INDEPENDENT_HOUSE', support)).json().total).toBeGreaterThanOrEqual(
      2,
    );
    expect((await get('/v1/properties', support)).body).not.toContain('Test Street'); // no exact address in lists
    expect((await get('/v1/reviews', support)).statusCode).toBe(200);
    expect((await get('/v1/payouts?status=PAID', finance)).json()).toMatchObject({ total: 0 });
  });
});

describe('fraud indicators and configuration', () => {
  it('surfaces repeat no-shows and reconciliation problems; config shows the rules in force', async () => {
    const l = await kit.listing(4, { units: ['N1', 'N2'] });
    const c = await kit.customer();
    for (const start of ['08:00', '14:00']) {
      const b = await kit.booked(
        c,
        l.assetId,
        at(istDay(4), start),
        at(istDay(4), `${Number(start.slice(0, 2)) + 1}:00`),
      );
      await kit.sql(`UPDATE booking.bookings SET status = 'NO_SHOW', hold_expires_at = NULL WHERE id = $1`, [
        b.id,
      ]); // test-only
    }
    const unknown = await pay.createOrder({ amountPaise: 500, receipt: 'stray', notes: {} });
    const hook = pay.simulate(unknown.orderId, 'captured');
    await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
    const signals = (await get('/v1/fraud-indicators', trust)).json();
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'REPEAT_NO_SHOW',
          subject: { kind: 'user', id: c.userId },
          count: 2,
        }),
        expect.objectContaining({ kind: 'RECONCILIATION_UNKNOWN_PAYMENT' }),
      ]),
    );
    const config = (await get('/v1/config', support)).json();
    expect(config).toMatchObject({
      pricing: { hostCommissionBps: 1000 },
      booking: { holdMinutes: 10, issueResponseMinutes: 15, noShowGraceMinutes: 30 },
      earnings: { releaseAfterHours: 48, minPayoutPaise: 10000 },
      providers: { payments: 'fake' },
    });
    expect(JSON.stringify(config)).not.toMatch(/KEY|SECRET/i);
  });
});
