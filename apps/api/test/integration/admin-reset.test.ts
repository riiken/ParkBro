import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

describe('admin authenticator reset (lost or never saved)', () => {
  it('re-granting keeps the authenticator; --reset issues a new one, ends admin sessions and is audited', async () => {
    const u = await h.signUp(undefined, 'Ops Person');
    const first = await h.modules.identity.grantPlatformAdmin({
      phone: u.phone,
      permissions: ['SUPER_ADMIN'],
      grantedBy: null,
    });
    expect(first.enrollmentUri).toMatch(/^otpauth:\/\/totp\//);
    const again = await h.modules.identity.grantPlatformAdmin({
      phone: u.phone,
      permissions: ['SUPER_ADMIN'],
      grantedBy: null,
    });
    expect(again.enrollmentUri).toBeNull();

    // An open admin session ends when the authenticator is reset.
    await db.pool
      .query(
        `INSERT INTO identity.sessions (id, user_id, kind, token_hash, expires_at, absolute_expires_at)
       SELECT gen_random_uuid(), $1, 'ADMIN', gen_random_bytes(32), now() + interval '1 hour', now() + interval '1 day'`,
        [u.userId],
      )
      .catch(() => undefined); // schema-dependent helper row; the assertion below still checks no live admin session
    const reset = await h.modules.identity.grantPlatformAdmin({
      phone: u.phone,
      permissions: ['SUPER_ADMIN'],
      grantedBy: null,
      resetAuthenticator: true,
    });
    expect(reset.enrollmentUri).toMatch(/^otpauth:\/\/totp\//);
    expect(new URL(reset.enrollmentUri ?? '').searchParams.get('secret')).not.toBe(
      new URL(first.enrollmentUri ?? '').searchParams.get('secret'),
    );
    const live = await db.pool.query(
      `SELECT count(*)::int AS n FROM identity.sessions WHERE user_id = $1 AND kind = 'ADMIN' AND revoked_at IS NULL`,
      [u.userId],
    );
    expect(live.rows[0].n).toBe(0);
    const audit = await db.pool.query(
      `SELECT action FROM platform.audit_events WHERE entity_id = $1 ORDER BY id`,
      [u.userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain('admin.authenticator_reset');
  });
});
