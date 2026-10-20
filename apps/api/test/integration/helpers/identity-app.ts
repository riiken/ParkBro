import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomInt } from 'node:crypto';
import { buildApp, type AppDependencies } from '../../../src/app.ts';
import { createModules, type Modules } from '../../../src/composition.ts';
import type { IdentityModule } from '../../../src/modules/identity/index.ts';
import { base32Decode, hotp, totpStep } from '../../../src/modules/identity/domain/totp.ts';
import type { AdminPermission } from '../../../src/platform/auth/actor.ts';
import { CURRENT_NOTICE_VERSION } from '../../../src/modules/identity/index.ts';
import { databaseReadiness } from '../../../src/modules/system/index.ts';
import { MIGRATIONS_DIR } from '../../../src/platform/db/cli-paths.ts';
import { createDb } from '../../../src/platform/db/database.ts';
import { loadMigrations, migrate } from '../../../src/platform/db/migrator.ts';
import { memoryStorage } from '../../../src/platform/providers/object-storage.ts';
import { memoryOtpSender } from '../../../src/platform/providers/otp.ts';
import { testEnv } from '../../helpers.ts';
import type { TestDatabase } from './db.ts';

export const CSRF = { 'x-requested-with': 'fetch' };

export function randomPhone(): string {
  return `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}
export function randomIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export interface IdentityHarness {
  app: FastifyInstance;
  identity: IdentityModule;
  /** The full module graph (internal services such as booking.confirmPayment and the jobs). */
  modules: Modules;
  storage: ReturnType<typeof memoryStorage>;
  otp: ReturnType<typeof memoryOtpSender>;
  /** Raw POST with CSRF header and a per-call random IP (so per-IP rate limits don't bleed across tests). */
  post(
    url: string,
    payload: unknown,
    opts?: { cookie?: string; ip?: string },
  ): Promise<LightMyRequestResponse>;
  get(url: string, cookie?: string): Promise<LightMyRequestResponse>;
  /** Full sign-up of a new user; returns the session cookie header value. */
  signUp(phone?: string, name?: string): Promise<{ cookie: string; userId: string; phone: string }>;
  signIn(phone: string): Promise<string>;
  /** Test-only: forget the 30-second per-number resend window (the product rule itself is tested separately). */
  skipResendWindow(): Promise<void>;
  /** Registers a user, grants PLATFORM_ADMIN with `permissions`, signs in with OTP + TOTP; returns the admin cookie. */
  adminSignIn(permissions: AdminPermission[]): Promise<string>;
  /** A signed-up user who has become a host; returns their user cookie and host account id. */
  hostSignUp(
    name?: string,
  ): Promise<{ cookie: string; userId: string; hostAccountId: string; phone: string }>;
  close(): Promise<void>;
}

export function cookieHeader(res: LightMyRequestResponse, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} cookie in response (status ${res.statusCode}: ${res.body})`);
  return `${c.name}=${c.value}`;
}

export async function identityHarness(
  db: TestDatabase,
  extra: Pick<AppDependencies, 'extraRoutes' | 'logStream' | 'onRoute'> = {},
  moduleOverrides: Omit<Parameters<typeof createModules>[2], 'otpSender' | 'storage'> = {},
  envOverrides: Record<string, string> = {},
): Promise<IdentityHarness> {
  await migrate(db.pool, await loadMigrations(MIGRATIONS_DIR), { info: () => undefined });
  const env = testEnv({
    DATABASE_URL: db.url,
    LOG_LEVEL: extra.logStream ? 'info' : 'silent',
    ...envOverrides,
  });
  const kysely = createDb(db.pool);
  const otp = memoryOtpSender();
  const storage = memoryStorage();
  const modules = createModules(env, kysely, { otpSender: otp, storage, ...moduleOverrides });
  const identity = modules.identity;
  const app = await buildApp({
    env,
    readiness: databaseReadiness(db.pool, await loadMigrations(MIGRATIONS_DIR)),
    modules,
    ...extra,
  });
  await app.ready();

  const post: IdentityHarness['post'] = (url, payload, opts = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { ...CSRF, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      remoteAddress: opts.ip ?? randomIp(),
    });
  const get: IdentityHarness['get'] = (url, cookie) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const skipResendWindow = async () => {
    await db.pool.query(`DELETE FROM platform.rate_limit_counters WHERE key LIKE 'otp-send:phone30s:%'`);
  };

  async function verifyLatest(phone: string, base = '/api/v1/auth') {
    await skipResendWindow();
    const req = await post(`${base}/otp/request`, { phone });
    if (req.statusCode !== 202) throw new Error(`otp request failed: ${req.body}`);
    const code = otp.lastCode(`+91${phone.slice(-10)}`) ?? '';
    return post(`${base}/otp/verify`, { challengeId: req.json().challengeId, code });
  }

  const harness: IdentityHarness = {
    app,
    identity,
    storage,
    otp,
    post,
    get,
    async signUp(phone = randomPhone(), name = 'Test User') {
      const verified = await verifyLatest(phone);
      const reg = await post('/api/v1/auth/register', {
        ticket: verified.json().ticket,
        displayName: name,
        ageAttested: true,
        acceptedNoticeVersion: CURRENT_NOTICE_VERSION,
      });
      if (reg.statusCode !== 201) throw new Error(`register failed: ${reg.body}`);
      return { cookie: cookieHeader(reg, '__Host-pb_session'), userId: reg.json().user.id as string, phone };
    },
    async signIn(phone) {
      const res = await verifyLatest(phone);
      return cookieHeader(res, '__Host-pb_session');
    },
    skipResendWindow,
    async adminSignIn(permissions) {
      const { phone } = await harness.signUp(undefined, 'Admin');
      const grant = await identity.grantPlatformAdmin({ phone, permissions, grantedBy: null });
      await skipResendWindow();
      const req = await post('/api/admin/auth/otp/request', { phone });
      const verify = await post('/api/admin/auth/otp/verify', {
        challengeId: req.json().challengeId,
        code: otp.lastCode(`+91${phone}`) ?? '',
      });
      const secret = new URL(grant.enrollmentUri ?? '').searchParams.get('secret') ?? '';
      const totp = await post('/api/admin/auth/totp', {
        ticket: verify.json().ticket,
        code: hotp(base32Decode(secret), totpStep(Math.floor(Date.now() / 1000))),
      });
      return cookieHeader(totp, '__Host-pb_admin');
    },
    async hostSignUp(name = 'Host Person') {
      const user = await harness.signUp(undefined, name);
      const res = await post(
        '/api/v1/host/account',
        { kind: 'INDIVIDUAL', displayName: name },
        { cookie: user.cookie },
      );
      if (res.statusCode !== 201) throw new Error(`become host failed: ${res.body}`);
      return { ...user, hostAccountId: res.json().hostAccountId as string };
    },
    modules,
    close: () => app.close(),
  };
  return harness;
}
