import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_GUARD } from '../../src/platform/auth/authentication.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
const routes: RouteOptions[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, { onRoute: (r) => routes.push(r) });
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

/**
 * Every route without a guard preHandler (requireUser / requireRole / requirePermission) must be listed here with
 * the reason it is public and what protects it instead (Phase 23 audit, production-readiness §2). A new public route
 * fails this test until it is reviewed and added.
 */
const PUBLIC: Record<string, string> = {
  'GET /api/health/live': 'liveness probe',
  'GET /api/health/ready': 'readiness probe (no data beyond check names)',
  'GET /api/health/ops': 'bearer OPS_MONITOR_TOKEN (constant-time); 404 when unset; counts only',
  'GET /api/docs/openapi.json': 'API docs, only when API_DOCS_ENABLED (off in production)',
  'GET /api/v1/auth/notice': 'sign-in privacy notice',
  'POST /api/v1/auth/otp/request': 'sign-in; per-IP and per-phone rate limits, enumeration-safe',
  'POST /api/v1/auth/otp/verify': 'sign-in; attempt limits and lockout',
  'POST /api/v1/auth/register': 'needs a single-use registration ticket from a verified OTP',
  'POST /api/v1/auth/logout': 'clears the caller’s own session cookie',
  'POST /api/admin/auth/otp/request': 'admin sign-in step 1; rate limited',
  'POST /api/admin/auth/otp/verify': 'admin sign-in step 1; attempt limits',
  'POST /api/admin/auth/totp': 'admin sign-in step 2; needs the step-1 ticket',
  'POST /api/admin/auth/logout': 'clears the caller’s own admin session',
  'GET /api/v1/listings/search': 'public discovery views only (no exact location); rate limited',
  'GET /api/v1/listings/:listingId': 'public listing view (approximate location only)',
  'GET /api/v1/listings/:listingId/availability': 'coarse public availability; no booking details',
  'GET /api/v1/listings/:listingId/reviews': 'published reviews, first name + initial only',
  'GET /api/v1/places/autocomplete': 'public localities only; rate limited',
  'GET /api/v1/places/:placeId': 'public locality point',
  'GET /api/v1/places/area': 'locality name for a ~1 km-rounded point; rate limited',
  'GET /api/v1/media/:mediaId': 'per-item visibility check: published listing photos, else owner only',
  'GET /api/v1/access/pass/:token': 'signed, expiring, revocable driver pass; rate limited',
  'GET /api/v1/gate/:token': 'hashed 192-bit guard-link token; rate limited',
  'POST /api/v1/gate/:token/lookup': 'guard link token; full code or plate only; rate limited',
  'POST /api/v1/gate/:token/entries': 'guard link token + gate-bound signed ticket',
  'POST /api/v1/ai/search-intent': 'produces search filters only; per-IP limits and daily budget',
  'POST /api/v1/ai/search-intent/:id/feedback': 'one anonymous answer per interpretation; rate limited',
  'POST /api/v1/webhooks/payments/fake':
    'HMAC-signed provider webhook (simulator; fake provider refused in production)',
  'POST /api/v1/webhooks/messaging/console': 'signed delivery receipts; the console provider accepts none',
};

const guarded = (r: RouteOptions) =>
  [r.preHandler ?? []].flat().some((fn) => typeof fn === 'function' && AUTH_GUARD in fn);
const key = (r: RouteOptions) => `${[r.method].flat().join(',')} ${r.url}`;

describe('route security inventory', () => {
  it('every route is guarded or a reviewed public route', () => {
    const open = routes.filter((r) => r.method !== 'HEAD' && !guarded(r)).map(key);
    expect(open.filter((k) => !(k in PUBLIC))).toEqual([]);
    expect(Object.keys(PUBLIC).filter((k) => !open.includes(k))).toEqual([]); // the list stays current
  });

  it('every admin API route outside sign-in requires an admin permission', () => {
    const admin = routes.filter(
      (r) => r.url.startsWith('/api/admin/') && !r.url.startsWith('/api/admin/auth/'),
    );
    expect(admin.length).toBeGreaterThan(40);
    const kinds = admin.map((r) => {
      const fn = [r.preHandler ?? []].flat().find((f) => typeof f === 'function' && AUTH_GUARD in f) as
        Record<symbol, string> | undefined;
      return `${key(r)} ${fn?.[AUTH_GUARD] ?? 'none'}`;
    });
    expect(kinds.filter((k) => !k.endsWith(' admin'))).toEqual([]);
  });

  it('state-changing public routes are CSRF-protected unless signed webhooks', () => {
    const exempt = routes
      .filter((r) => (r.config as { csrf?: boolean } | undefined)?.csrf === false)
      .map(key);
    expect(exempt.every((k) => k.includes('/webhooks/'))).toBe(true);
  });
});
