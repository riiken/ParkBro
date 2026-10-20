import { DateTime } from 'luxon';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, randomIp, type IdentityHarness } from './helpers/identity-app.ts';
import { publishListing } from './helpers/publish.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;

const IST = 'Asia/Kolkata';
const O = { latitude: 12.9352, longitude: 77.6245 };
const day = DateTime.now().setZone(IST).plus({ days: 3 }).startOf('day');
const at = (d: DateTime, hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return d.set({ hour: hh ?? 0, minute: mm ?? 0 }).toISO() ?? '';
};
const SECRET_ADDRESS = '12 HIDDENROAD, Koramangala';
const SECRET_ACCESS = 'HIDDENGATE code 9876';

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0 });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const randomPlate = () =>
  `KA${String(randomInt(1, 70)).padStart(2, '0')}${letters[randomInt(0, letters.length)]}${letters[randomInt(0, letters.length)]}${String(randomInt(1000, 10000))}`;

async function customer(vehicle: { vehicleClass?: string; isEv?: boolean; connectors?: string[] } = {}) {
  const user = await h.signUp(undefined, 'Priya Sharma');
  const res = await h.post(
    '/api/v1/me/vehicles',
    {
      plate: randomPlate(),
      vehicleClass: vehicle.vehicleClass ?? 'HATCHBACK',
      isEv: vehicle.isEv ?? false,
      connectors: vehicle.connectors ?? [],
    },
    { cookie: user.cookie },
  );
  expect(res.statusCode, res.body).toBe(201);
  return { ...user, vehicleId: res.json().id as string };
}

type Customer = Awaited<ReturnType<typeof customer>>;

async function quote(c: Customer, assetId: string, start: string, end: string, mode = 'HOURLY') {
  return h.post('/api/v1/quotes', { assetId, mode, start, end }, { cookie: c.cookie });
}

async function quoteId(c: Customer, assetId: string, start: string, end: string, mode = 'HOURLY') {
  const res = await quote(c, assetId, start, end, mode);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().quoteId as string;
}

function book(c: Customer, qid: string, key: string = randomUUID(), vehicleId = c.vehicleId) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': key },
    payload: { quoteId: qid, vehicleId },
    remoteAddress: randomIp(),
  });
}

async function booked(c: Customer, assetId: string, start: string, end: string) {
  const res = await book(c, await quoteId(c, assetId, start, end));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; status: string; [k: string]: unknown };
}

const listing = (seed: number, spec: Partial<Parameters<typeof publishListing>[2]> = {}) =>
  publishListing(h, admin, {
    seed,
    ...O,
    address: SECRET_ADDRESS,
    accessInstructions: SECRET_ACCESS,
    title: `Booking test spot ${'abcdefghijklmnop'[seed % 16]}`,
    ...spec,
  });

const sql = (text: string, params: unknown[] = []) => db.pool.query(text, params);

describe('quotes', () => {
  it('prices the window, snapshots the cancellation policy, and refuses what is not bookable', async () => {
    const l = await listing(1, { asset: { cancellationPolicy: 'FLEXIBLE' } });
    const c = await customer();
    const res = await quote(c, l.assetId, at(day, '10:00'), at(day, '12:30'));
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json();
    expect(q.totalPaise).toBe(3 * 4000); // hours round up (BR-16)
    expect(q.lines[0]).toMatchObject({ kind: 'BASE', quantity: 3, unitPricePaise: 4000 });
    expect(q.cancellationPolicy.code).toBe('FLEXIBLE');
    expect(new Date(q.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect((await quote(c, l.assetId, at(day, '10:00'), at(day, '11:00'), 'MONTHLY')).json().code).toBe(
      'booking.quote_invalid',
    );
    expect((await quote(c, l.assetId, at(day, '12:00'), at(day, '11:00'))).statusCode).toBe(400);
    const past = DateTime.now().startOf('hour').minus({ hours: 2 });
    expect(
      (await quote(c, l.assetId, past.toISO() ?? '', past.plus({ hours: 1 }).toISO() ?? '')).json().code,
    ).toBe('booking.unavailable');
    expect(
      (await quote(c, '01a1568b-0000-7000-8000-000000000000', at(day, '10:00'), at(day, '11:00'))).json()
        .code,
    ).toBe('booking.listing_unavailable');
    // Requires a session.
    expect(
      (
        await h.post('/api/v1/quotes', {
          assetId: l.assetId,
          mode: 'HOURLY',
          start: at(day, '10:00'),
          end: at(day, '11:00'),
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('creating a booking', () => {
  it('creates a payment hold on the first free space; the price is the quoted one', async () => {
    const l = await listing(2);
    const c = await customer();
    const qid = await quoteId(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    // A price change after the quote does not change what the customer pays (BR-11).
    await sql(`UPDATE pricing.rates SET price_paise = 99900 WHERE asset_id = $1`, [l.assetId]);
    const res = await book(c, qid);
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b.status).toBe('PENDING_PAYMENT');
    expect(b.price.totalPaise).toBe(4000);
    expect(b.access).toBeNull(); // nothing revealed before confirmation (L-6)
    expect(JSON.stringify(b)).not.toContain('HIDDEN');
    const holdMs = new Date(b.holdExpiresAt).getTime() - Date.now();
    expect(holdMs).toBeGreaterThan(9 * 60_000);
    expect(holdMs).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const events = await sql(
      `SELECT from_status, to_status, actor_kind FROM booking.booking_events WHERE booking_id = $1`,
      [b.id],
    );
    expect(events.rows).toEqual([
      { from_status: null, to_status: 'PENDING_PAYMENT', actor_kind: 'CUSTOMER' },
    ]);
    const audit = await sql(`SELECT action FROM platform.audit_events WHERE entity_id = $1`, [b.id]);
    expect(audit.rows.map((r) => r.action)).toContain('booking.created');
  });

  it('is idempotent per key: a retry returns the same booking; a key reused for another quote is refused', async () => {
    const l = await listing(3, { units: ['A1', 'A2'] });
    const c = await customer();
    const qid = await quoteId(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    const key = randomUUID();
    const [a, b] = await Promise.all([book(c, qid, key), book(c, qid, key)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect((await book(c, qid, key)).statusCode).toBe(200);
    const count = await sql(`SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1`, [
      c.userId,
    ]);
    expect(count.rows[0].n).toBe(1);

    const other = await quoteId(c, l.assetId, at(day, '13:00'), at(day, '14:00'));
    expect((await book(c, other, key)).json().code).toBe('booking.idempotency_conflict');
    // A used quote can't be booked again under a new key (BR-11).
    expect((await book(c, qid)).json().code).toBe('booking.quote_expired');
    // The key is required and well-formed.
    const missing = await h.post(
      '/api/v1/bookings',
      { quoteId: other, vehicleId: c.vehicleId },
      { cookie: c.cookie },
    );
    expect(missing.json().code).toBe('booking.idempotency_key_required');
  });

  it('never double-books a space under real concurrency', async () => {
    const l = await listing(4);
    const customers = await Promise.all(Array.from({ length: 6 }, () => customer()));
    const quotes = await Promise.all(
      customers.map((c) => quoteId(c, l.assetId, at(day, '10:00'), at(day, '12:00'))),
    );
    const results = await Promise.all(customers.map((c, i) => book(c, quotes[i] ?? '')));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json().code).toBe('booking.unavailable');
    const rows = await sql(
      `SELECT count(*)::int AS n FROM booking.bookings WHERE asset_id = $1 AND holds_unit`,
      [l.assetId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('spreads concurrent bookings across spaces and stops when the last one is taken', async () => {
    const l = await listing(5, { units: ['B1', 'B2', 'B3'] });
    const customers = await Promise.all(Array.from({ length: 5 }, () => customer()));
    const quotes = await Promise.all(
      customers.map((c) => quoteId(c, l.assetId, at(day, '15:00'), at(day, '16:00'))),
    );
    const results = await Promise.all(customers.map((c, i) => book(c, quotes[i] ?? '')));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
    const units = await sql(
      `SELECT DISTINCT unit_id FROM booking.bookings WHERE asset_id = $1 AND holds_unit`,
      [l.assetId],
    );
    expect(units.rows).toHaveLength(3);
  });

  it('re-checks availability at commit: a stale quote, a new block or a short buffer gap is refused', async () => {
    const l = await listing(6, { asset: { bufferMinutes: 30 } });
    const [first, late, blocked] = await Promise.all([customer(), customer(), customer()]);
    const stale = await quoteId(late, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await booked(first, l.assetId, at(day, '10:00'), at(day, '11:00'));
    const res = await book(late, stale);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'booking.unavailable', title: 'Just booked by someone else' });

    // Buffer (BR-02): 11:00–11:30 is turnover time; 11:30 is fine.
    expect((await quote(late, l.assetId, at(day, '11:15'), at(day, '12:15'))).json().code).toBe(
      'booking.unavailable',
    );
    expect((await quote(late, l.assetId, at(day, '11:30'), at(day, '12:30'))).statusCode).toBe(201);

    const q = await quoteId(blocked, l.assetId, at(day, '16:00'), at(day, '17:00'));
    const block = await h.post(
      `/api/v1/host/assets/${l.assetId}/availability-exceptions`,
      { kind: 'BLOCK', start: at(day, '15:00'), end: at(day, '18:00'), reason: 'Family visiting' },
      { cookie: l.host.cookie },
    );
    expect(block.statusCode, block.body).toBe(201);
    const after = await book(blocked, q);
    expect(after.json()).toMatchObject({ code: 'booking.unavailable', title: 'Not available for that time' });
  });

  it('refuses an expired quote, someone else’s quote or vehicle, and a vehicle that does not fit', async () => {
    const l = await listing(7, { parking: { maxVehicleClass: 'SEDAN' } });
    const [c, other] = await Promise.all([customer(), customer()]);
    const qid = await quoteId(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect((await book(other, qid)).statusCode).toBe(404);
    expect((await book(c, qid, randomUUID(), other.vehicleId)).json().code).toBe('vehicle.not_found');

    const suv = await h.post(
      '/api/v1/me/vehicles',
      { plate: randomPlate(), vehicleClass: 'SUV' },
      { cookie: c.cookie },
    );
    expect((await book(c, qid, randomUUID(), suv.json().id)).json().code).toBe(
      'booking.vehicle_incompatible',
    );

    await sql(`UPDATE pricing.quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [qid]);
    expect((await book(c, qid)).json().code).toBe('booking.quote_expired');
  });

  it('a host cannot book their own listing', async () => {
    const l = await listing(19);
    const res = await h.post(
      '/api/v1/me/vehicles',
      { plate: randomPlate(), vehicleClass: 'HATCHBACK' },
      { cookie: l.host.cookie },
    );
    expect(res.statusCode).toBe(201);
    const q = await h.post(
      '/api/v1/quotes',
      { assetId: l.assetId, mode: 'HOURLY', start: at(day, '10:00'), end: at(day, '11:00') },
      { cookie: l.host.cookie },
    );
    expect(q.json().code).toBe('booking.own_listing');
  });

  it('EV charging needs an EV with a matching connector', async () => {
    const l = await listing(8, {
      type: 'EV_CHARGING',
      charger: { connectors: ['CCS2'] },
      asset: { minMinutes: 30, maxMinutes: 240 },
    });
    const petrol = await customer();
    const wrongPlug = await customer({ isEv: true, connectors: ['TYPE2'] });
    const ok = await customer({ isEv: true, connectors: ['CCS2', 'TYPE2'] });
    for (const [c, expected] of [
      [petrol, 'booking.vehicle_incompatible'],
      [wrongPlug, 'booking.vehicle_incompatible'],
    ] as const) {
      const res = await book(
        c,
        await quoteId(c, l.assetId, at(day, '10:00'), at(day, '11:00'), 'CHARGING_SESSION'),
      );
      expect(res.json().code).toBe(expected);
    }
    const res = await book(
      ok,
      await quoteId(ok, l.assetId, at(day, '10:00'), at(day, '11:00'), 'CHARGING_SESSION'),
    );
    expect(res.statusCode, res.body).toBe(201);
  });

  it('enforces the property outsider cap across spaces (BR-06)', async () => {
    const l = await listing(9, { units: ['C1', 'C2', 'C3'] });
    await sql(`UPDATE properties.properties SET outsider_cap = 2 WHERE id = $1`, [l.propertyId]);
    const customers = await Promise.all(Array.from({ length: 4 }, () => customer()));
    const quotes = await Promise.all(
      customers.map((c) => quoteId(c, l.assetId, at(day, '10:00'), at(day, '11:00'))),
    );
    const results = await Promise.all(customers.map((c, i) => book(c, quotes[i] ?? '')));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    const refused = results.filter((r) => r.statusCode === 409).map((r) => r.json().detail);
    expect(refused).toHaveLength(2);
    // Refused at the cap (or, for one that raced the unit, as reserved); never over the cap.
    const n = await sql(
      `SELECT count(*)::int AS n FROM booking.bookings WHERE property_id = $1 AND holds_unit`,
      [l.propertyId],
    );
    expect(n.rows[0].n).toBe(2);
    // A non-overlapping window is unaffected.
    const later = customers[3] as Customer;
    expect(
      (await book(later, await quoteId(later, l.assetId, at(day, '12:00'), at(day, '13:00')))).statusCode,
    ).toBe(201);
  });
});

describe('lapsed holds', () => {
  it('stop blocking immediately, read as EXPIRED, and are tidied by the booking transaction and the job', async () => {
    const l = await listing(10);
    const [slow, fast] = await Promise.all([customer(), customer()]);
    const hold = await booked(slow, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect((await quote(fast, l.assetId, at(day, '10:00'), at(day, '11:00'))).statusCode).toBe(409);

    await sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [
      hold.id,
    ]);
    expect((await h.get(`/api/v1/bookings/${hold.id}`, slow.cookie)).json().status).toBe('EXPIRED');
    const search = await h.app.inject({
      method: 'GET',
      url: `/api/v1/listings/search?${new URLSearchParams({ lat: String(O.latitude), lng: String(O.longitude), type: 'PARKING', mode: 'HOURLY', start: at(day, '10:00'), end: at(day, '11:00') })}`,
      remoteAddress: randomIp(),
    });
    expect((search.json().results as { id: string }[]).map((r) => r.id)).toContain(l.assetId);

    const res = await book(fast, await quoteId(fast, l.assetId, at(day, '10:00'), at(day, '11:00')));
    expect(res.statusCode, res.body).toBe(201);
    const old = await sql(`SELECT status FROM booking.bookings WHERE id = $1`, [hold.id]);
    expect(old.rows[0].status).toBe('EXPIRED');
    const ev = await sql(
      `SELECT from_status, to_status, actor_kind FROM booking.booking_events WHERE booking_id = $1 ORDER BY id`,
      [hold.id],
    );
    expect(ev.rows.at(-1)).toEqual({
      from_status: 'PENDING_PAYMENT',
      to_status: 'EXPIRED',
      actor_kind: 'SYSTEM',
    });
  });

  it('the expiry job marks lapsed holds and approvals', async () => {
    const l = await listing(11, { units: ['D1', 'D2'] });
    const c = await customer();
    const b = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [
      b.id,
    ]);
    expect(await h.modules.booking.expireLapsedHolds()).toBeGreaterThanOrEqual(1);
    expect((await sql(`SELECT status FROM booking.bookings WHERE id = $1`, [b.id])).rows[0].status).toBe(
      'EXPIRED',
    );
    expect(await h.modules.booking.expireLapsedHolds()).toBe(0);
  });
});

describe('host approval', () => {
  it('requests wait for the host, who can approve (starting the payment hold) or decline', async () => {
    const l = await listing(12, { asset: { approvalRequired: true }, units: ['E1', 'E2'] });
    const [a, b] = await Promise.all([customer(), customer()]);
    const ra = await booked(a, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect(ra.status).toBe('AWAITING_HOST_APPROVAL');
    expect(new Date(ra.approvalExpiresAt as string).getTime()).toBeLessThanOrEqual(
      Date.now() + 12 * 3_600_000 + 5_000,
    );
    const rb = await booked(b, l.assetId, at(day, '10:00'), at(day, '11:00'));

    const list = await h.get('/api/v1/host/bookings', l.host.cookie);
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list
        .json()
        .map((x: { id: string }) => x.id)
        .sort(),
    ).toEqual([ra.id, rb.id].sort());
    expect(list.json()[0].customer.name).toBe('Priya S.');

    // Another host sees nothing and can't act.
    const stranger = await h.hostSignUp();
    expect((await h.get(`/api/v1/host/bookings/${ra.id}`, stranger.cookie)).statusCode).toBe(404);
    expect(
      (await h.post(`/api/v1/host/bookings/${ra.id}/approve`, {}, { cookie: stranger.cookie })).statusCode,
    ).toBe(404);
    // A customer can't approve their own request.
    expect(
      (await h.post(`/api/v1/host/bookings/${ra.id}/approve`, {}, { cookie: a.cookie })).json().code,
    ).toBe('host.not_a_host');

    const approved = await h.post(`/api/v1/host/bookings/${ra.id}/approve`, {}, { cookie: l.host.cookie });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().status).toBe('PENDING_PAYMENT');
    expect((await h.get(`/api/v1/bookings/${ra.id}`, a.cookie)).json().holdExpiresAt).not.toBeNull();
    expect(
      (await h.post(`/api/v1/host/bookings/${ra.id}/approve`, {}, { cookie: l.host.cookie })).json().code,
    ).toBe('booking.transition_not_allowed');

    const declined = await h.post(
      `/api/v1/host/bookings/${rb.id}/decline`,
      { reason: 'Car wash that day' },
      { cookie: l.host.cookie },
    );
    expect(declined.json().status).toBe('DECLINED');
    // A declined request frees the space.
    const c = await customer();
    expect((await quote(c, l.assetId, at(day, '10:00'), at(day, '11:00'))).statusCode).toBe(201);
  });

  it('a lapsed approval window cannot be approved', async () => {
    const l = await listing(13, { asset: { approvalRequired: true } });
    const c = await customer();
    const r = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await sql(`UPDATE booking.bookings SET approval_expires_at = now() - interval '1 second' WHERE id = $1`, [
      r.id,
    ]);
    expect(
      (await h.post(`/api/v1/host/bookings/${r.id}/approve`, {}, { cookie: l.host.cookie })).json().code,
    ).toBe('booking.transition_not_allowed');
  });
});

describe('confirmation and access (L-6)', () => {
  it('reveals the exact address, space and instructions only to the customer of a confirmed booking', async () => {
    const l = await listing(14, { units: ['F7'] });
    const [c, other] = await Promise.all([customer(), customer()]);
    const b = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect(await h.modules.booking.confirmPayment(b.id, 'test')).toEqual({ confirmed: true });
    expect(await h.modules.booking.confirmPayment(b.id, 'test')).toEqual({ confirmed: true }); // idempotent

    const view = (await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json();
    expect(view.status).toBe('CONFIRMED');
    expect(view.access).toEqual({ address: SECRET_ADDRESS, unitLabel: 'F7', instructions: SECRET_ACCESS });
    expect((await h.get(`/api/v1/bookings/${b.id}`, other.cookie)).statusCode).toBe(404);
    expect((await h.get('/api/v1/bookings', other.cookie)).json()).toEqual([]);

    // The host sees the plate and the customer's short name, not their phone.
    const hv = (await h.get(`/api/v1/host/bookings/${b.id}`, l.host.cookie)).json();
    expect(hv.vehicle.plate).toMatch(/^KA \d{2} [A-Z]{2} \d{4}$/);
    expect(JSON.stringify(hv)).not.toContain(c.phone.slice(-6));

    // Access closes 24 h after the end.
    await sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '27 hours', now() - interval '26 hours', '[)') WHERE id = $1`,
      [b.id],
    );
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().access).toBeNull();
    // And the finished booking completes.
    expect(await h.modules.booking.completeFinished()).toBeGreaterThanOrEqual(1);
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('COMPLETED');
  });

  it('a late payment revives a lapsed hold only if the space is still free', async () => {
    const l = await listing(15);
    const [a, b] = await Promise.all([customer(), customer()]);
    const first = await booked(a, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [
      first.id,
    ]);
    expect(await h.modules.booking.confirmPayment(first.id, 'test')).toEqual({ confirmed: true });

    const second = await booked(b, l.assetId, at(day, '13:00'), at(day, '14:00'));
    await sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [
      second.id,
    ]);
    await h.modules.booking.expireLapsedHolds();
    await booked(a, l.assetId, at(day, '13:00'), at(day, '14:00'));
    expect(await h.modules.booking.confirmPayment(second.id, 'test')).toEqual({ confirmed: false }); // payments refunds it
  });
});

describe('cancellation', () => {
  it('customer: unpaid holds cancel free; paid bookings refund per the snapshotted policy', async () => {
    const l = await listing(16, { asset: { cancellationPolicy: 'FLEXIBLE' }, units: ['G1', 'G2'] });
    const c = await customer();
    const hold = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    const cancelled = await h.post(`/api/v1/bookings/${hold.id}/cancel`, {}, { cookie: c.cookie });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      status: 'CANCELLED',
      cancellation: { cancelledBy: 'CUSTOMER', refundPaise: 0 },
    });

    const paid = await booked(c, l.assetId, at(day, '13:00'), at(day, '15:00'));
    await h.modules.booking.confirmPayment(paid.id, 'test');
    // The host tightening the policy later doesn't affect this booking (BR-22).
    const asset = (await h.get(`/api/v1/host/assets/${l.assetId}`, l.host.cookie)).json();
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/host/assets/${l.assetId}`,
      headers: { ...CSRF, cookie: l.host.cookie },
      payload: { version: asset.version, cancellationPolicy: 'STRICT' },
    });
    const preview = (await h.get(`/api/v1/bookings/${paid.id}`, c.cookie)).json();
    expect(preview.cancellation.refundIfCancelledNowPaise).toBe(8000);
    const res = await h.post(
      `/api/v1/bookings/${paid.id}/cancel`,
      { reason: 'Plans changed' },
      { cookie: c.cookie },
    );
    expect(res.json().cancellation).toMatchObject({ cancelledBy: 'CUSTOMER', refundPaise: 8000 });
    expect((await h.post(`/api/v1/bookings/${paid.id}/cancel`, {}, { cookie: c.cookie })).json().code).toBe(
      'booking.transition_not_allowed',
    );
    // The space is free again.
    expect((await quote(c, l.assetId, at(day, '13:00'), at(day, '15:00'))).statusCode).toBe(201);
    const audit = await sql(
      `SELECT metadata FROM platform.audit_events WHERE entity_id = $1 AND action = 'booking.cancelled'`,
      [paid.id],
    );
    expect(audit.rows[0].metadata).toMatchObject({ refundPaise: 8000 });
  });

  it('customer: an in-progress booking cannot be self-cancelled', async () => {
    const l = await listing(20);
    const c = await customer();
    const b = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await h.modules.booking.confirmPayment(b.id, 'test');
    await sql(`UPDATE booking.bookings SET status = 'IN_PROGRESS' WHERE id = $1`, [b.id]);
    const res = await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('booking.transition_not_allowed');
  });

  it('host: a reason is required and the customer is refunded in full', async () => {
    const l = await listing(17, { asset: { cancellationPolicy: 'STRICT' } });
    const c = await customer();
    const b = await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    await h.modules.booking.confirmPayment(b.id, 'test');
    expect(
      (await h.post(`/api/v1/host/bookings/${b.id}/cancel`, {}, { cookie: l.host.cookie })).statusCode,
    ).toBe(400);
    const res = await h.post(
      `/api/v1/host/bookings/${b.id}/cancel`,
      { reason: 'Gate is being repaired' },
      { cookie: l.host.cookie },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'CANCELLED', cancelledBy: 'HOST' });
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().cancellation).toMatchObject({
      cancelledBy: 'HOST',
      refundPaise: 4000,
    });
    // Other customers can't cancel it.
    const other = await customer();
    expect((await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: other.cookie })).statusCode).toBe(
      404,
    );
  });
});

describe('availability consumers see bookings', () => {
  it('the host calendar shows the reservation and search hides the booked single space', async () => {
    const l = await listing(18);
    const c = await customer();
    await booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    const cal = await h.get(
      `/api/v1/host/assets/${l.assetId}/calendar?from=${encodeURIComponent(at(day, '00:00'))}&to=${encodeURIComponent(at(day.plus({ days: 1 }), '00:00'))}`,
      l.host.cookie,
    );
    expect(cal.statusCode, cal.body).toBe(200);
    expect(cal.json().reservations).toHaveLength(1);
    const search = await h.app.inject({
      method: 'GET',
      url: `/api/v1/listings/search?${new URLSearchParams({ lat: String(O.latitude), lng: String(O.longitude), type: 'PARKING', mode: 'HOURLY', start: at(day, '10:30'), end: at(day, '11:30') })}`,
      remoteAddress: randomIp(),
    });
    expect((search.json().results as { id: string }[]).map((r) => r.id)).not.toContain(l.assetId);
  });
});
