import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_NOTICE_VERSION } from '../../src/modules/identity/index.ts';
import { requireRole } from '../../src/platform/auth/authentication.ts';
import { captureLogs } from '../helpers.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import {
  CSRF,
  cookieHeader,
  identityHarness,
  randomIp,
  randomPhone,
  type IdentityHarness,
} from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
const logs = captureLogs();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {
    logStream: logs.stream,
    extraRoutes: (api) => {
      api.get('/test/host-only', { preHandler: requireRole('HOST') }, async () => ({ ok: true }));
    },
  });
});
afterAll(async () => {
  await h.close();
  await db.drop();
});

const e164 = (phone: string) => `+91${phone}`;

async function requestCode(phone: string, ip?: string, opts: { keepResendWindow?: boolean } = {}) {
  if (!opts.keepResendWindow) await h.skipResendWindow();
  const res = await h.post('/api/v1/auth/otp/request', { phone }, ip ? { ip } : {});
  return { res, challengeId: res.json().challengeId as string, code: h.otp.lastCode(e164(phone)) ?? '' };
}

describe('OTP request', () => {
  it('rejects invalid numbers with a stable code', async () => {
    const res = await h.post('/api/v1/auth/otp/request', { phone: '12345' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('auth.phone_invalid');
  });

  it('responds identically for registered and unregistered numbers (no account enumeration)', async () => {
    const { phone } = await h.signUp();
    const known = (await requestCode(phone)).res;
    const unknown = (await requestCode(randomPhone())).res;
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(Object.keys(known.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
  });

  it('normalises the number and delivers a 6-digit code', async () => {
    const phone = randomPhone();
    await h.post('/api/v1/auth/otp/request', { phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}` });
    expect(h.otp.lastCode(e164(phone))).toMatch(/^\d{6}$/);
  });

  it('limits resends per number (30 s) with Retry-After', async () => {
    const phone = randomPhone();
    expect((await requestCode(phone)).res.statusCode).toBe(202);
    const again = (await requestCode(phone, undefined, { keepResendWindow: true })).res;
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe('request.rate_limited');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits requests per IP address (20 per hour)', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await requestCode(randomPhone(), ip)).res.statusCode);
    expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('OTP verification', () => {
  it('counts wrong attempts and locks the challenge after five', async () => {
    const phone = randomPhone();
    const { challengeId, code } = await requestCode(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const details: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.post('/api/v1/auth/otp/verify', { challengeId, code: wrong });
      expect(res.json().code).toBe('auth.otp_incorrect');
      details.push(res.json().detail);
    }
    expect(details[0]).toMatch(/4 attempts left/);
    expect(details[4]).toMatch(/Too many attempts/);
    const correctButLocked = await h.post('/api/v1/auth/otp/verify', { challengeId, code });
    expect(correctButLocked.json().code).toBe('auth.otp_expired');
  });

  it('rejects an expired code', async () => {
    const { challengeId, code } = await requestCode(randomPhone());
    await db.pool.query(
      `UPDATE identity.otp_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [challengeId],
    );
    expect((await h.post('/api/v1/auth/otp/verify', { challengeId, code })).json().code).toBe(
      'auth.otp_expired',
    );
  });

  it('a newer code supersedes an older one', async () => {
    const phone = randomPhone();
    const first = await requestCode(phone);
    await requestCode(phone);
    const old = await h.post('/api/v1/auth/otp/verify', { challengeId: first.challengeId, code: first.code });
    expect(old.json().code).toBe('auth.otp_expired');
  });

  it('a code cannot be reused after a successful sign-in', async () => {
    const { phone } = await h.signUp();
    const { challengeId, code } = await requestCode(phone);
    expect((await h.post('/api/v1/auth/otp/verify', { challengeId, code })).json().status).toBe(
      'AUTHENTICATED',
    );
    expect((await h.post('/api/v1/auth/otp/verify', { challengeId, code })).json().code).toBe(
      'auth.otp_expired',
    );
  });

  it('rejects malformed input', async () => {
    const res = await h.post('/api/v1/auth/otp/verify', { challengeId: 'not-a-uuid', code: '12' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('request.invalid');
  });
});

describe('registration', () => {
  async function ticketFor(phone = randomPhone()) {
    const { challengeId, code } = await requestCode(phone);
    const res = await h.post('/api/v1/auth/otp/verify', { challengeId, code });
    expect(res.json().status).toBe('REGISTRATION_REQUIRED');
    return res.json().ticket as string;
  }
  const body = (ticket: string, extra: object = {}) => ({
    ticket,
    displayName: 'Asha',
    ageAttested: true,
    acceptedNoticeVersion: CURRENT_NOTICE_VERSION,
    ...extra,
  });

  it('creates the account with a secure session cookie, CUSTOMER role, consents and audit', async () => {
    const res = await h.post('/api/v1/auth/register', body(await ticketFor()));
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === '__Host-pb_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBeUndefined();
    const user = res.json().user;
    expect(user).toMatchObject({ displayName: 'Asha', roles: ['CUSTOMER'], locale: 'en' });
    expect(user.phoneMasked).toMatch(/^\+91 ••••••\d{4}$/);

    const consents = await db.pool.query(
      'SELECT purpose, notice_version FROM identity.consents WHERE user_id = $1 ORDER BY purpose',
      [user.id],
    );
    expect(consents.rows).toEqual([
      { purpose: 'PRIVACY', notice_version: CURRENT_NOTICE_VERSION },
      { purpose: 'TERMS', notice_version: CURRENT_NOTICE_VERSION },
    ]);
    const audit = await db.pool.query(`SELECT action FROM platform.audit_events WHERE actor_id = $1`, [
      user.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toContain('user.registered');
  });

  it('stores the phone number encrypted, never in plaintext', async () => {
    const { userId, phone } = await h.signUp();
    const row = await db.pool.query(
      'SELECT phone_enc, phone_hmac, phone_last4 FROM identity.users WHERE id = $1',
      [userId],
    );
    const r = row.rows[0] as { phone_enc: Buffer; phone_hmac: Buffer; phone_last4: string };
    expect(r.phone_enc.includes(Buffer.from(phone))).toBe(false);
    expect(r.phone_hmac.includes(Buffer.from(phone))).toBe(false);
    expect(r.phone_last4).toBe(phone.slice(-4));
    const challenges = await db.pool.query('SELECT phone_enc FROM identity.otp_challenges');
    for (const c of challenges.rows as { phone_enc: Buffer }[])
      expect(c.phone_enc.includes(Buffer.from(phone))).toBe(false);
  });

  it('requires 18+ attestation and the current notice version', async () => {
    const ticket = await ticketFor();
    expect((await h.post('/api/v1/auth/register', body(ticket, { ageAttested: false }))).json().code).toBe(
      'request.invalid',
    );
    expect(
      (await h.post('/api/v1/auth/register', body(ticket, { acceptedNoticeVersion: 'old' }))).json().code,
    ).toBe('auth.notice_outdated');
    expect(
      (await h.post('/api/v1/auth/register', body(ticket, { displayName: '<script>' }))).statusCode,
    ).toBe(400);
  });

  it('rejects reused, expired and tampered tickets', async () => {
    const ticket = await ticketFor();
    expect((await h.post('/api/v1/auth/register', body(ticket))).statusCode).toBe(201);
    expect((await h.post('/api/v1/auth/register', body(ticket))).json().code).toBe('auth.ticket_invalid');

    const expiring = await ticketFor();
    await db.pool.query(
      `UPDATE identity.otp_challenges SET ticket_expires_at = now() - interval '1 second' WHERE id = $1`,
      [expiring.split('.')[0]],
    );
    expect((await h.post('/api/v1/auth/register', body(expiring))).json().code).toBe('auth.ticket_invalid');

    const tampered = `${(await ticketFor()).split('.')[0]}.${'A'.repeat(43)}`;
    expect((await h.post('/api/v1/auth/register', body(tampered))).json().code).toBe('auth.ticket_invalid');
  });

  it('a ticket used concurrently creates exactly one account', async () => {
    const ticket = await ticketFor();
    const results = await Promise.all([1, 2, 3].map(() => h.post('/api/v1/auth/register', body(ticket))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400]);
  });

  it('two devices registering the same number end up on one account', async () => {
    const phone = randomPhone();
    const t1 = await ticketFor(phone);
    // Second device: verify a fresh code before the first registers (the first challenge is superseded only if pending).
    const t2 = await ticketFor(phone);
    const [a, b] = await Promise.all([
      h.post('/api/v1/auth/register', body(t1)),
      h.post('/api/v1/auth/register', body(t2)),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().user.id).toBe(b.json().user.id);
    const count = await db.pool.query(
      `SELECT count(*)::int AS n FROM identity.users
        WHERE phone_hmac = (SELECT phone_hmac FROM identity.otp_challenges WHERE id = $1)`,
      [t1.split('.')[0]],
    );
    expect(count.rows[0].n).toBe(1);
  });
});

describe('sessions', () => {
  it('existing users sign in directly', async () => {
    const { phone, userId } = await h.signUp();
    const cookie = await h.signIn(phone);
    expect((await h.get('/api/v1/me', cookie)).json().id).toBe(userId);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const { cookie } = await h.signUp();
    const out = await h.post('/api/v1/auth/logout', {}, { cookie });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === '__Host-pb_session');
    expect(cleared?.value).toBe('');
    expect((await h.get('/api/v1/me', cookie)).statusCode).toBe(401);
  });

  it('expired (idle) and absolutely-expired sessions are rejected', async () => {
    const a = await h.signUp();
    await db.pool.query(
      `UPDATE identity.sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [a.userId],
    );
    expect((await h.get('/api/v1/me', a.cookie)).statusCode).toBe(401);

    const b = await h.signUp();
    await db.pool.query(
      `UPDATE identity.sessions SET expires_at = now() - interval '2 seconds', absolute_expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [b.userId],
    );
    expect((await h.get('/api/v1/me', b.cookie)).statusCode).toBe(401);
  });

  it('slides the idle expiry on use, capped by the absolute expiry', async () => {
    const { cookie, userId } = await h.signUp();
    await db.pool.query(
      `UPDATE identity.sessions SET last_seen_at = now() - interval '1 hour', expires_at = now() + interval '1 hour',
         absolute_expires_at = now() + interval '2 days' WHERE user_id = $1`,
      [userId],
    );
    expect((await h.get('/api/v1/me', cookie)).statusCode).toBe(200);
    const row = await db.pool.query(
      `SELECT expires_at > now() + interval '1 day' AS extended, expires_at <= absolute_expires_at AS capped FROM identity.sessions WHERE user_id = $1`,
      [userId],
    );
    expect(row.rows[0]).toEqual({ extended: true, capped: true });
  });

  it('suspended users lose existing sessions and cannot sign in', async () => {
    const { cookie, userId, phone } = await h.signUp();
    await db.pool.query(`UPDATE identity.users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
    expect((await h.get('/api/v1/me', cookie)).statusCode).toBe(401);
    const { challengeId, code } = await requestCode(phone);
    const res = await h.post('/api/v1/auth/otp/verify', { challengeId, code });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.account_suspended');
  });

  it('users can list and revoke their own sessions, but not anyone else’s', async () => {
    const owner = await h.signUp();
    const secondDevice = await h.signIn(owner.phone);
    const list = (await h.get('/api/v1/me/sessions', owner.cookie)).json() as {
      id: string;
      current: boolean;
    }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = list.find((s) => !s.current);

    const intruder = await h.signUp();
    const attempt = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${other?.id}`,
      headers: { ...CSRF, cookie: intruder.cookie },
    });
    expect(attempt.statusCode).toBe(404);
    expect((await h.get('/api/v1/me', secondDevice)).statusCode).toBe(200);

    const revoke = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/sessions/${other?.id}`,
      headers: { ...CSRF, cookie: owner.cookie },
    });
    expect(revoke.statusCode).toBe(204);
    expect((await h.get('/api/v1/me', secondDevice)).statusCode).toBe(401);
    expect((await h.get('/api/v1/me', owner.cookie)).statusCode).toBe(200);
  });
});

describe('profile', () => {
  const patch = (cookie: string, payload: object) =>
    h.app.inject({ method: 'PATCH', url: '/api/v1/me', payload, headers: { ...CSRF, cookie } });

  it('updates name and locale, auditing field names but not values', async () => {
    const { cookie, userId } = await h.signUp();
    const res = await patch(cookie, { displayName: 'Ravi K', locale: 'hi' });
    expect(res.json()).toMatchObject({ displayName: 'Ravi K', locale: 'hi' });
    const audit = await db.pool.query(
      `SELECT metadata FROM platform.audit_events WHERE actor_id = $1 AND action = 'user.profile_updated'`,
      [userId],
    );
    expect(audit.rows[0].metadata).toEqual({ fields: 'display_name,locale' });
    expect(JSON.stringify(audit.rows)).not.toContain('Ravi');
  });

  it('validates input and rejects unknown fields (no mass assignment)', async () => {
    const { cookie } = await h.signUp();
    expect((await patch(cookie, {})).statusCode).toBe(400);
    expect((await patch(cookie, { displayName: '' })).statusCode).toBe(400);
    expect((await patch(cookie, { locale: 'fr' })).statusCode).toBe(400);
    expect((await patch(cookie, { roles: ['PLATFORM_ADMIN'] })).statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await h.get('/api/v1/me')).statusCode).toBe(401);
    expect((await patch('__Host-pb_session=' + 'x'.repeat(43), { locale: 'en' })).statusCode).toBe(401);
  });
});

describe('roles', () => {
  it('a customer cannot use host-only routes', async () => {
    const { cookie } = await h.signUp();
    const res = await h.get('/api/test/host-only', cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden');
  });
});

describe('admin sign-in (OTP + TOTP)', () => {
  async function totpFromUri(uri: string, offsetSteps = 0) {
    const { base32Decode, hotp, totpStep } = await import('../../src/modules/identity/domain/totp.ts');
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    return hotp(base32Decode(secret), totpStep(Math.floor(Date.now() / 1000)) + offsetSteps);
  }
  async function adminTicket(phone: string) {
    await h.skipResendWindow();
    const req = await h.post('/api/admin/auth/otp/request', { phone });
    const code = h.otp.lastCode(e164(phone)) ?? '';
    return h.post('/api/admin/auth/otp/verify', { challengeId: req.json().challengeId, code });
  }

  it('refuses non-admins after OTP', async () => {
    const { phone } = await h.signUp();
    const res = await adminTicket(phone);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.not_admin');
  });

  it('full flow: grant, OTP, TOTP, admin session with permissions; replay and cookie isolation enforced', async () => {
    const { phone, cookie: userCookie } = await h.signUp(undefined, 'Admin Person');
    const grant = await h.identity.grantPlatformAdmin({
      phone,
      permissions: ['SUPPORT', 'FINANCE'],
      grantedBy: null,
    });
    expect(grant.enrollmentUri).toMatch(/^otpauth:\/\/totp\//);
    const regrant = await h.identity.grantPlatformAdmin({ phone, permissions: ['SUPPORT'], grantedBy: null });
    expect(regrant.enrollmentUri).toBeNull();

    const verify = await adminTicket(phone);
    expect(verify.json().status).toBe('TOTP_REQUIRED');
    const code = await totpFromUri(grant.enrollmentUri ?? '');
    const totp = await h.post('/api/admin/auth/totp', { ticket: verify.json().ticket, code });
    expect(totp.statusCode).toBe(200);
    expect(totp.json().admin.permissions).toEqual(['FINANCE', 'SUPPORT']);
    const adminCookie = cookieHeader(totp, '__Host-pb_admin');

    expect((await h.get('/api/admin/me', adminCookie)).json().permissions).toEqual(['FINANCE', 'SUPPORT']);
    // Cookie isolation: a user session never grants admin access, and the admin cookie is not a user session.
    expect((await h.get('/api/admin/me', userCookie)).statusCode).toBe(401);
    expect((await h.get('/api/v1/me', adminCookie)).statusCode).toBe(401);

    // Replay: the same TOTP step cannot be used again.
    const second = await adminTicket(phone);
    const replay = await h.post('/api/admin/auth/totp', { ticket: second.json().ticket, code });
    expect(replay.json().code).toBe('auth.totp_incorrect');

    // Losing PLATFORM_ADMIN ends admin access immediately, even with a live admin session.
    const userId = totp.json().admin.id as string;
    await db.pool.query(`DELETE FROM identity.role_grants WHERE user_id = $1 AND role = 'PLATFORM_ADMIN'`, [
      userId,
    ]);
    expect((await h.get('/api/admin/me', adminCookie)).statusCode).toBe(401);

    const audit = await db.pool.query(
      `SELECT action FROM platform.audit_events WHERE entity_id = $1::text OR actor_id = $1::uuid`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['admin.granted', 'admin.login', 'admin.totp_failed']),
    );
  });

  it('locks the TOTP step after five wrong codes', async () => {
    const { phone } = await h.signUp();
    const grant = await h.identity.grantPlatformAdmin({ phone, permissions: ['SUPPORT'], grantedBy: null });
    const verify = await adminTicket(phone);
    const ticket = verify.json().ticket as string;
    const good = await totpFromUri(grant.enrollmentUri ?? '');
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await h.post('/api/admin/auth/totp', { ticket, code: bad })).json().code).toBe(
        'auth.totp_incorrect',
      );
    }
    expect((await h.post('/api/admin/auth/totp', { ticket, code: good })).json().code).toBe(
      'auth.ticket_invalid',
    );
  });

  it('admin logout ends the admin session', async () => {
    const { phone } = await h.signUp();
    const grant = await h.identity.grantPlatformAdmin({
      phone,
      permissions: ['SUPER_ADMIN'],
      grantedBy: null,
    });
    const verify = await adminTicket(phone);
    const totp = await h.post('/api/admin/auth/totp', {
      ticket: verify.json().ticket,
      code: await totpFromUri(grant.enrollmentUri ?? ''),
    });
    const adminCookie = cookieHeader(totp, '__Host-pb_admin');
    expect((await h.post('/api/admin/auth/logout', {}, { cookie: adminCookie })).statusCode).toBe(204);
    expect((await h.get('/api/admin/me', adminCookie)).statusCode).toBe(401);
  });
});

describe('PII hygiene', () => {
  it('rate-limit keys never contain raw IP addresses', async () => {
    const ip = '203.0.113.77';
    await h.post('/api/v1/auth/otp/request', { phone: randomPhone() }, { ip });
    const keys = (
      await db.pool.query<{ key: string }>('SELECT key FROM platform.rate_limit_counters')
    ).rows.map((r) => r.key);
    expect(keys.some((k) => k.startsWith('otp-send:ip1h:'))).toBe(true);
    expect(keys.join('\n')).not.toContain(ip);
  });

  it('the whole auth flow never writes phone numbers, OTP codes or tokens to the logs', async () => {
    const { phone, cookie } = await h.signUp();
    const raw = logs.raw();
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(cookie.split('=')[1]);
    for (const m of h.otp.sent) expect(raw).not.toContain(`"${m.code}"`);
  });
});
