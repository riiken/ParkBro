import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let trust: string;
let support: string;
let kit: ReturnType<typeof bookingKit>;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, {}, { PILOT_CUSTOMER_CLEARANCE: 'true' });
  trust = await h.adminSignIn(['TRUST_SAFETY']);
  support = await h.adminSignIn(['SUPPORT']);
  kit = bookingKit(h, () => trust, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const clearance = (userId: string, body: object, cookie: string) =>
  h.post(`/api/admin/v1/users/${userId}/clearance`, body, { cookie });

describe('controlled pilot: customer clearance (D-168)', () => {
  it('uncleared customers can quote but not book; trust & safety clears and revokes with a reason', async () => {
    const l = await kit.listing(1, { units: ['A1', 'A2'] });
    const c = await kit.customer();
    const window = [at(istDay(2), '10:00'), at(istDay(2), '12:00')] as const;

    const refused = await kit.book(c, await kit.quoteId(c, l.assetId, ...window));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'booking.customer_not_cleared' });

    expect((await h.get(`/api/admin/v1/users/${c.userId}/clearance`, support)).json()).toEqual({
      required: true,
      status: 'NONE',
      history: [],
    });
    expect(
      (await clearance(c.userId, { decision: 'CLEARED', reason: 'RC and ID seen' }, support)).statusCode,
    ).toBe(403);
    expect((await clearance(c.userId, { decision: 'CLEARED', reason: 'x' }, trust)).statusCode).toBe(400);
    expect(
      (await clearance(c.userId, { decision: 'CLEARED', reason: 'RC and Aadhaar checked on call' }, trust))
        .statusCode,
    ).toBe(204);

    const booked = await kit.booked(c, l.assetId, ...window);
    expect(booked.status).toBe('PENDING_PAYMENT');

    expect(
      (await clearance(c.userId, { decision: 'REVOKED', reason: 'Fake RC reported by host' }, trust))
        .statusCode,
    ).toBe(204);
    const again = await kit.book(
      c,
      await kit.quoteId(c, l.assetId, at(istDay(3), '10:00'), at(istDay(3), '11:00')),
    );
    expect(again.statusCode).toBe(403);

    const view = (await h.get(`/api/admin/v1/users/${c.userId}/clearance`, trust)).json();
    expect(view.status).toBe('REVOKED');
    expect(view.history.map((x: { decision: string }) => x.decision)).toEqual(['REVOKED', 'CLEARED']);
    const audit = (await h.get(`/api/admin/v1/audit?entityKind=user&entityId=${c.userId}`, trust)).json();
    expect(audit.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['user.clearance_granted', 'user.clearance_revoked']),
    );
  });
});
