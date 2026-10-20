import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let trust: string;
let support: string;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db);
  trust = await h.adminSignIn(['TRUST_SAFETY']);
  support = await h.adminSignIn(['SUPPORT']);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

describe('data-rights requests (DPDP, D-169)', () => {
  it('a customer requests erasure once; trust & safety resolves it with an audited outcome', async () => {
    const c = await h.signUp(undefined, 'Priya Sharma');
    const other = await h.signUp(undefined, 'Ravi Kumar');
    expect((await h.post('/api/v1/me/data-requests', { kind: 'ERASURE' })).statusCode).toBe(401);

    const first = await h.post(
      '/api/v1/me/data-requests',
      { kind: 'ERASURE', details: 'Moving abroad' },
      { cookie: c.cookie },
    );
    expect(first.statusCode).toBe(201);
    const req = first.json();
    expect(req).toMatchObject({ kind: 'ERASURE', status: 'OPEN', details: 'Moving abroad' });
    const dueInDays = (Date.parse(req.dueAt) - Date.parse(req.createdAt)) / 86_400_000;
    expect(Math.round(dueInDays)).toBe(30);

    const again = await h.post('/api/v1/me/data-requests', { kind: 'ERASURE' }, { cookie: c.cookie });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(req.id);
    expect((await h.get('/api/v1/me/data-requests', other.cookie)).json()).toEqual([]); // private

    expect((await h.get('/api/admin/v1/data-requests?status=OPEN', support)).statusCode).toBe(403);
    const queue = (await h.get('/api/admin/v1/data-requests?status=OPEN', trust)).json();
    expect(queue.items).toEqual([expect.objectContaining({ id: req.id, userId: c.userId, kind: 'ERASURE' })]);

    const resolve = (body: object) =>
      h.post(`/api/admin/v1/data-requests/${req.id}/resolve`, body, { cookie: trust });
    expect((await resolve({ status: 'COMPLETED', resolution: 'x' })).statusCode).toBe(400);
    expect(
      (await resolve({ status: 'COMPLETED', resolution: 'Anonymised per runbook; bookings kept for tax' }))
        .statusCode,
    ).toBe(204);
    expect((await resolve({ status: 'REJECTED', resolution: 'Second attempt' })).statusCode).toBe(404);
    expect((await h.get('/api/v1/me/data-requests', c.cookie)).json()[0]).toMatchObject({
      status: 'COMPLETED',
      resolution: 'Anonymised per runbook; bookings kept for tax',
    });
    const audit = (await h.get(`/api/admin/v1/audit?entityKind=user&entityId=${c.userId}`, trust)).json();
    expect(audit.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['data_request.erasure_requested', 'data_request.completed']),
    );
  });
});
