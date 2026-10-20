import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, {}, { STAGING_ALLOWED_PHONES: '9000000101,+919000000102' });
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

describe('staging is invite-only (D-172)', () => {
  it('sends sign-in codes only to allowlisted numbers, for customers and admins alike', async () => {
    const send = (url: string, phone: string) => h.post(url, { phone });
    expect((await send('/api/v1/auth/otp/request', '9000000101')).statusCode).toBe(202);
    expect((await send('/api/v1/auth/otp/request', '+91 90000 00102')).statusCode).toBe(202);
    const refused = await send('/api/v1/auth/otp/request', '9000000199');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'auth.invite_only' });
    expect((await send('/api/admin/auth/otp/request', '9000000199')).statusCode).toBe(403);
  });
});
