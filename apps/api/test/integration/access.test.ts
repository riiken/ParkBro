import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bookingKit, IST, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, randomIp, type IdentityHarness } from './helpers/identity-app.ts';

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

type Listing = Awaited<ReturnType<typeof kit.listing>>;
type Customer = Awaited<ReturnType<typeof kit.customer>>;

const listingWithAccess = (seed: number, extra: Parameters<typeof kit.listing>[1] = {}) =>
  kit.listing(seed, {
    units: ['G1', 'G2'],
    address: '5 SECRETGATE Road',
    accessInstructions: 'Gate code is on the pass',
    ...extra,
  });

/** A confirmed booking whose window is open now (starts in 2 minutes). */
async function bookingNow(l: Listing, c?: Customer) {
  const customer = c ?? (await kit.customer());
  const start = DateTime.now().setZone(IST).plus({ minutes: 2 }).startOf('minute');
  const b = await kit.booked(
    customer,
    l.assetId,
    start.toISO() ?? '',
    start.plus({ hours: 2 }).toISO() ?? '',
  );
  expect(await h.modules.booking.confirmPayment(b.id, 'test')).toEqual({ confirmed: true });
  return { c: customer, b };
}

async function gate(l: Listing, label = 'Main gate') {
  const res = await h.post(
    `/api/v1/host/properties/${l.propertyId}/gates`,
    { label },
    { cookie: l.host.cookie },
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

const lookup = (token: string, body: object) =>
  h.app.inject({
    method: 'POST',
    url: `/api/v1/gate/${token}/lookup`,
    headers: CSRF,
    payload: body,
    remoteAddress: randomIp(),
  });
const access = async (c: Customer, id: string) => h.get(`/api/v1/bookings/${id}/access`, c.cookie);

describe('grants', () => {
  it('a confirmed booking gets a plate-bound code; holds and strangers get nothing', async () => {
    const l = await listingWithAccess(1);
    const { c, b } = await bookingNow(l);
    const res = await access(c, b.id);
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json();
    expect(a).toMatchObject({ status: 'ACTIVE', unitLabel: 'G1', canCheckIn: true });
    expect(a.code).toMatch(/^\d{6}$/);
    expect(a.plate).toMatch(/^KA \d{2} [A-Z]{2} \d{4}$/);
    expect(a.passToken).toContain('.');
    const raw = await kit.sql(
      `SELECT code_enc::text AS e, code_hmac::text AS hm FROM access.access_grants WHERE booking_id = $1`,
      [b.id],
    );
    expect(raw.rows[0].e).not.toContain(a.code);

    const other = await kit.customer();
    expect((await access(other, b.id)).json().code).toBe('access.not_available');
    const hold = await kit.booked(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '11:00'));
    expect((await access(c, hold.id)).json().code).toBe('access.not_available');
  });

  it('cancellation revokes access everywhere', async () => {
    const l = await listingWithAccess(2);
    const { c, b } = await bookingNow(l);
    const token = await gate(l);
    const before = (await access(c, b.id)).json();
    await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect((await access(c, b.id)).json()).toMatchObject({ status: 'REVOKED', code: null, passToken: null });
    expect((await lookup(token, { code: before.code })).json()).toEqual({
      valid: false,
      reason: 'NO_BOOKING_NOW',
    });
    expect((await h.get(`/api/v1/access/pass/${before.passToken}`)).statusCode).toBe(404);
    const events = await kit.sql(
      `SELECT kind FROM access.access_events e JOIN access.access_grants g ON g.id = e.grant_id WHERE g.booking_id = $1 ORDER BY e.id`,
      [b.id],
    );
    expect(events.rows.map((r) => r.kind)).toEqual(['ISSUED', 'REVOKED']); // the denied lookup has no grant
  });

  it('a reissued code replaces the old one', async () => {
    const l = await listingWithAccess(3);
    const { c, b } = await bookingNow(l);
    const token = await gate(l);
    const old = (await access(c, b.id)).json().code;
    const fresh = (await h.post(`/api/v1/bookings/${b.id}/access/reissue`, {}, { cookie: c.cookie })).json()
      .code;
    expect(fresh).toMatch(/^\d{6}$/);
    expect(fresh).not.toBe(old);
    expect((await lookup(token, { code: old })).json().valid).toBe(false);
    expect((await lookup(token, { code: fresh })).json().valid).toBe(true);
  });
});

describe('check-in and the guard link', () => {
  it('the customer checks in inside the window; outside it is refused', async () => {
    const l = await listingWithAccess(4);
    const { c, b } = await bookingNow(l);
    const res = await h.post(`/api/v1/bookings/${b.id}/check-in`, {}, { cookie: c.cookie });
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('IN_PROGRESS');
    const later = await kit.booked(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '11:00'));
    await h.modules.booking.confirmPayment(later.id, 'test');
    expect(
      (await h.post(`/api/v1/bookings/${later.id}/check-in`, {}, { cookie: c.cookie })).json().code,
    ).toBe('access.outside_window');
  });

  it('a guard verifies by code or plate, sees only what is needed, and records the entry', async () => {
    const l = await listingWithAccess(5);
    const { c, b } = await bookingNow(l);
    const token = await gate(l);
    const mine = (await access(c, b.id)).json();
    expect((await h.get(`/api/v1/gate/${token}`)).json()).toMatchObject({ label: 'Main gate' });

    const byCode = await lookup(token, { code: mine.code });
    expect(byCode.statusCode, byCode.body).toBe(200);
    expect(byCode.json()).toMatchObject({
      valid: true,
      unitLabel: 'G1',
      expectedPlate: mine.plate,
      alreadyEntered: false,
    });
    expect(byCode.body).not.toContain('Priya');
    expect(byCode.body).not.toContain(c.phone.slice(-6));
    expect(byCode.body).not.toContain(b.id);
    const byPlate = await lookup(token, { plate: mine.plate.toLowerCase().replaceAll(' ', '') });
    expect(byPlate.json().valid).toBe(true);
    expect((await lookup(token, { code: '000000' === mine.code ? '000001' : '000000' })).json().valid).toBe(
      false,
    );
    expect((await lookup(token, { plate: 'KA01' })).json().valid).toBe(false); // no partial search
    expect((await lookup(token, { plate: mine.plate, code: mine.code })).statusCode).toBe(400);

    const entry = await h.app.inject({
      method: 'POST',
      url: `/api/v1/gate/${token}/entries`,
      headers: CSRF,
      payload: { ticket: byCode.json().entryTicket },
    });
    expect(entry.statusCode, entry.body).toBe(200);
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('IN_PROGRESS');
    expect((await access(c, b.id)).json().status).toBe('USED');
    expect((await lookup(token, { code: mine.code })).json()).toMatchObject({
      valid: true,
      alreadyEntered: true,
    });

    // A ticket is bound to its gate and can't be forged.
    const other = await gate(l, 'Back gate');
    const wrongGate = await h.app.inject({
      method: 'POST',
      url: `/api/v1/gate/${other}/entries`,
      headers: CSRF,
      payload: { ticket: byCode.json().entryTicket },
    });
    expect(wrongGate.json().code).toBe('access.invalid_ticket');
    const forged = await h.app.inject({
      method: 'POST',
      url: `/api/v1/gate/${token}/entries`,
      headers: CSRF,
      payload: { ticket: `${byCode.json().entryTicket}x` },
    });
    expect(forged.json().code).toBe('access.invalid_ticket');

    // A code from another property's booking doesn't work at this gate.
    const elsewhere = await listingWithAccess(6);
    const e = await bookingNow(elsewhere);
    const theirs = (await access(e.c, e.b.id)).json().code;
    expect((await lookup(token, { code: theirs })).json().valid).toBe(false);
  });

  it('gate links: owner only, revocable, rate-limited; the access log shows every check', async () => {
    const l = await listingWithAccess(7);
    const stranger = await h.hostSignUp();
    expect(
      (
        await h.post(
          `/api/v1/host/properties/${l.propertyId}/gates`,
          { label: 'X' },
          { cookie: stranger.cookie },
        )
      ).statusCode,
    ).toBe(404);
    const token = await gate(l);
    const gates = (await h.get(`/api/v1/host/properties/${l.propertyId}/gates`, l.host.cookie)).json();
    expect(gates[0]).toMatchObject({ label: 'Main gate', status: 'ACTIVE' });
    expect(JSON.stringify(gates)).not.toContain(token);
    const stored = await kit.sql(`SELECT token_hash FROM access.gate_tokens WHERE id = $1`, [gates[0].id]);
    expect(stored.rows[0].token_hash.toString('utf8')).not.toContain(token);

    for (let i = 0; i < 60; i += 1) await lookup(token, { code: '123456' });
    const limited = await lookup(token, { code: '123456' });
    expect(limited.statusCode).toBe(429);

    const log = (await h.get(`/api/v1/host/properties/${l.propertyId}/access-log`, l.host.cookie)).json();
    expect(log.length).toBeGreaterThanOrEqual(60);
    expect(log[0]).toMatchObject({ kind: 'DENIED', source: 'GUARD', method: 'CODE', gate: 'Main gate' });
    expect(JSON.stringify(log)).not.toContain('123456');
    expect(
      (await h.get(`/api/v1/host/properties/${l.propertyId}/access-log`, stranger.cookie)).statusCode,
    ).toBe(404);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/host/properties/${l.propertyId}/gates/${gates[0].id}`,
      headers: { ...CSRF, cookie: l.host.cookie },
    });
    expect(del.statusCode).toBe(204);
    expect((await h.get(`/api/v1/gate/${token}`)).json().code).toBe('access.invalid_gate');
    expect((await h.get('/api/v1/gate/not-a-real-token-but-long-enough-xx')).json().code).toBe(
      'access.invalid_gate',
    );
  });

  it('the driver pass shows the address and instructions without an account, and is signed', async () => {
    const l = await listingWithAccess(8);
    const { c, b } = await bookingNow(l);
    const a = (await access(c, b.id)).json();
    const pass = await h.get(`/api/v1/access/pass/${a.passToken}`);
    expect(pass.statusCode, pass.body).toBe(200);
    expect(pass.json()).toMatchObject({
      address: '5 SECRETGATE Road',
      instructions: 'Gate code is on the pass',
      code: a.code,
      unitLabel: 'G1',
    });
    expect(String(a.passToken).length).toBeLessThan(100);
    const [payload, sig] = String(a.passToken).split('.');
    const tampered = `${'0'.repeat(32)}~${(Date.now() + 1e9).toString(36)}.${sig}`;
    expect((await h.get(`/api/v1/access/pass/${tampered}`)).statusCode).toBe(404);
    expect((await h.get(`/api/v1/access/pass/${payload}.AAAAAAAAAAAAAAAAAAAAAA`)).statusCode).toBe(404);
    // A guard can verify the pass too.
    const token = await gate(l);
    expect((await lookup(token, { pass: a.passToken })).json().valid).toBe(true);
  });

  it('external systems (ANPR) admit by plate through the same grants', async () => {
    const l = await listingWithAccess(9);
    const { c, b } = await bookingNow(l);
    const plate = (await access(c, b.id)).json().plate as string;
    expect(
      await h.modules.access.ingestExternal(
        { kind: 'ANPR', propertyId: l.propertyId, plate, at: Date.now() },
        'test',
      ),
    ).toEqual({ admitted: true });
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('IN_PROGRESS');
    expect(
      await h.modules.access.ingestExternal(
        { kind: 'ANPR', propertyId: l.propertyId, plate: 'KA 99 ZZ 9999', at: Date.now() },
        'test',
      ),
    ).toEqual({ admitted: false });
    const kinds = await kit.sql(
      `SELECT kind, method FROM access.access_events WHERE property_id = $1 AND source = 'ADAPTER' ORDER BY id`,
      [l.propertyId],
    );
    expect(kinds.rows).toEqual([
      { kind: 'ENTERED', method: 'ANPR' },
      { kind: 'DENIED', method: 'ANPR' },
    ]);
  });
});

describe('recourse (BR-24) and no-show (BR-26)', () => {
  it('"I can\'t get in": the host fixes it on site, or the customer is refunded in full after 15 minutes', async () => {
    const l = await listingWithAccess(10);
    const { c, b } = await bookingNow(l);
    const opened = await h.post(
      `/api/v1/bookings/${b.id}/issues`,
      { kind: 'ACCESS_DENIED', note: 'Guard says no booking' },
      { cookie: c.cookie },
    );
    expect(opened.statusCode, opened.body).toBe(201);
    const issue = opened.json().issue;
    expect(issue).toMatchObject({ kind: 'ACCESS_DENIED', status: 'OPEN' });
    expect(new Date(issue.deadlineAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(
      (
        await h.post(`/api/v1/bookings/${b.id}/issues`, { kind: 'UNIT_OCCUPIED' }, { cookie: c.cookie })
      ).json().code,
    ).toBe('issue.already_open');
    const hostView = (await h.get(`/api/v1/host/bookings/${b.id}`, l.host.cookie)).json();
    expect(hostView.issue).toMatchObject({ id: issue.id, status: 'OPEN' });
    const resolved = await h.post(
      `/api/v1/host/bookings/${b.id}/issues/${issue.id}/resolve`,
      { note: 'Called the guard' },
      { cookie: l.host.cookie },
    );
    expect(resolved.json().issue.status).toBe('RESOLVED_ON_SITE');

    // Second problem, nobody responds.
    const second = (
      await h.post(`/api/v1/bookings/${b.id}/issues`, { kind: 'UNIT_OCCUPIED' }, { cookie: c.cookie })
    ).json().issue;
    await kit.sql(
      `UPDATE booking.booking_issues SET deadline_at = now() - interval '1 second' WHERE id = $1`,
      [second.id],
    );
    expect(await h.modules.booking.autoResolveIssues()).toBe(1);
    const after = (await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json();
    expect(after).toMatchObject({
      status: 'CANCELLED',
      issue: { status: 'REFUNDED' },
      cancellation: { cancelledBy: 'PLATFORM', refundPaise: 8000 },
    });
    expect((await access(c, b.id)).json().status).toBe('REVOKED');
  });

  it('issues only in the access window; the customer can withdraw or escalate', async () => {
    const l = await listingWithAccess(11);
    const c = await kit.customer();
    const later = await kit.booked(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '11:00'));
    await h.modules.booking.confirmPayment(later.id, 'test');
    expect(
      (
        await h.post(`/api/v1/bookings/${later.id}/issues`, { kind: 'CANNOT_FIND' }, { cookie: c.cookie })
      ).json().code,
    ).toBe('issue.not_in_window');
    const { b } = await bookingNow(l, c);
    const i = (
      await h.post(`/api/v1/bookings/${b.id}/issues`, { kind: 'CANNOT_FIND' }, { cookie: c.cookie })
    ).json().issue;
    const esc = await h.post(`/api/v1/bookings/${b.id}/issues/${i.id}/escalate`, {}, { cookie: c.cookie });
    expect(esc.json().issue.status).toBe('ESCALATED');
    expect(await h.modules.booking.autoResolveIssues()).toBe(0); // escalated issues wait for support
    const stranger = await kit.customer();
    expect(
      (await h.post(`/api/v1/bookings/${b.id}/issues/${i.id}/withdraw`, {}, { cookie: stranger.cookie }))
        .statusCode,
    ).toBe(404);
  });

  it('the host may report a no-show only 30 minutes after the start, without check-in or an open issue', async () => {
    const l = await listingWithAccess(12, { units: ['N1'] });
    const { c, b } = await bookingNow(l);
    expect((await h.get(`/api/v1/host/bookings/${b.id}`, l.host.cookie)).json().canReportNoShow).toBe(false);
    expect(
      (await h.post(`/api/v1/host/bookings/${b.id}/no-show`, {}, { cookie: l.host.cookie })).json().code,
    ).toBe('booking.transition_not_allowed');
    // 40 minutes in, never arrived (test time travel).
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '40 minutes', now() + interval '80 minutes', '[)') WHERE id = $1`,
      [b.id],
    );
    await kit.sql(
      `UPDATE access.access_grants SET valid_from = now() - interval '55 minutes', valid_until = now() + interval '95 minutes' WHERE booking_id = $1`,
      [b.id],
    );
    const issue = (
      await h.post(`/api/v1/bookings/${b.id}/issues`, { kind: 'ACCESS_DENIED' }, { cookie: c.cookie })
    ).json().issue;
    expect((await h.get(`/api/v1/host/bookings/${b.id}`, l.host.cookie)).json().canReportNoShow).toBe(false); // stuck at the gate
    await h.post(`/api/v1/bookings/${b.id}/issues/${issue.id}/withdraw`, {}, { cookie: c.cookie });
    expect((await h.get(`/api/v1/host/bookings/${b.id}`, l.host.cookie)).json().canReportNoShow).toBe(true);
    const res = await h.post(`/api/v1/host/bookings/${b.id}/no-show`, {}, { cookie: l.host.cookie });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('NO_SHOW');
    expect((await access(c, b.id)).json().status).toBe('REVOKED');
    // The space is free again for the rest of the time.
    const other = await kit.customer();
    const soon = DateTime.now().setZone(IST).plus({ minutes: 5 }).startOf('minute');
    expect(
      (await kit.quote(other, l.assetId, soon.toISO() ?? '', soon.plus({ minutes: 60 }).toISO() ?? ''))
        .statusCode,
    ).toBe(201);
  });
});
