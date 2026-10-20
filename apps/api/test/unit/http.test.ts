import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { problemDetailsSchema } from '@parkbro/contracts';
import type { AuthenticatedActor, SessionResolver } from '../../src/platform/auth/actor.ts';
import { actorOf, requireRole, requireUser } from '../../src/platform/auth/authentication.ts';
import {
  ADMIN_SESSION_COOKIE,
  USER_SESSION_COOKIE,
  generateSessionToken,
  hashSessionToken,
} from '../../src/platform/auth/session-token.ts';
import { DomainError } from '../../src/platform/errors/domain-error.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/platform/http/security.ts';
import { captureLogs, testApp, testEnv } from '../helpers.ts';

const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE };

async function routes(api: FastifyInstance) {
  const r = api.withTypeProvider<ZodTypeProvider>();
  r.post(
    '/test/echo',
    { schema: { body: z.object({ name: z.string().min(2), count: z.number().int().positive() }) } },
    async (req) => ({ ok: req.body.name }),
  );
  r.get('/test/domain-error', async () => {
    throw new DomainError({
      code: 'booking.unavailable',
      status: 409,
      title: 'Spot taken',
      detail: 'Try another',
    });
  });
  r.get('/test/crash', async () => {
    throw new Error('db password is hunter2');
  });
  r.get(
    '/test/leaky',
    { schema: { response: { 200: z.object({ id: z.string() }) } } },
    async () => ({ id: 'a', exactAddress: '12 Secret Lane' }) as { id: string },
  );
  r.get('/test/bad-shape', { schema: { response: { 200: z.object({ id: z.string() }) } } }, async () => ({
    id: 42 as unknown as string,
  }));
  r.post('/test/webhook', { config: { csrf: false } }, async () => ({ received: true }));
  r.get('/test/me', { preHandler: requireUser }, async (req) => ({ userId: actorOf(req).userId }));
  r.get('/test/host-only', { preHandler: requireRole('HOST') }, async () => ({ ok: true }));
  r.get('/admin/test/me', { preHandler: requireUser }, async (req) => ({ kind: actorOf(req).sessionKind }));
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function expectProblem(body: unknown, code: string, status: number) {
  const problem = problemDetailsSchema.parse(body);
  expect(problem).toMatchObject({ code, status, type: `/problems/${code}` });
  expect(problem.requestId).toBeTruthy();
  return problem;
}

describe('request IDs', () => {
  it('generates an ID and echoes it in the response header and problem body', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(expectProblem(res.json(), 'route.not_found', 404).requestId).toBe(id);
  });

  it('accepts a well-formed upstream ID and replaces a malformed one', async () => {
    app = await testApp();
    const ok = await app.inject({ url: '/api/health/live', headers: { 'x-request-id': 'edge-trace-12345' } });
    expect(ok.headers['x-request-id']).toBe('edge-trace-12345');
    const bad = await app.inject({
      url: '/api/health/live',
      headers: { 'x-request-id': 'bad id\n{"inject":1}' },
    });
    expect(bad.headers['x-request-id']).not.toContain('inject');
  });
});

describe('security headers', () => {
  it('are set on every response, with no-store caching by default', async () => {
    app = await testApp();
    const res = await app.inject({ url: '/api/health/live' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS in production', async () => {
    // Production env validation would refuse this config (dev keys, no OTP provider), so build it directly.
    app = await testApp({ env: { ...testEnv(), NODE_ENV: 'production' } });
    const res = await app.inject({ url: '/api/health/live' });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });
});

describe('problem+json errors', () => {
  it('validation errors list each invalid field', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: csrf,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const problem = expectProblem(res.json(), 'request.invalid', 400);
    expect(problem.errors?.map((e) => e.path).sort()).toEqual(['body/count', 'body/name']);
  });

  it('domain errors keep their code, status and user-safe detail', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({ url: '/api/test/domain-error' });
    expect(expectProblem(res.json(), 'booking.unavailable', 409)).toMatchObject({
      title: 'Spot taken',
      detail: 'Try another',
    });
  });

  it('unexpected errors return a generic 500 and never leak the message', async () => {
    const logs = captureLogs();
    app = await testApp({ extraRoutes: routes, logStream: logs.stream });
    const res = await app.inject({ url: '/api/test/crash' });
    expectProblem(res.json(), 'internal', 500);
    expect(res.body).not.toContain('hunter2');
    expect(logs.entries().some((e) => e.level === 50 && e.msg === 'unhandled error')).toBe(true);
  });

  it('malformed JSON and oversized bodies map to stable codes', async () => {
    app = await testApp({ extraRoutes: routes });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expectProblem(malformed.json(), 'request.malformed', 400);
    const big = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(70 * 1024), count: 1 }),
    });
    expectProblem(big.json(), 'request.too_large', 413);
  });
});

describe('response shaping', () => {
  it('strips fields that are not in the response schema (no accidental data exposure)', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({ url: '/api/test/leaky' });
    expect(res.json()).toEqual({ id: 'a' });
    expect(res.body).not.toContain('Secret Lane');
  });

  it('a response that violates its schema becomes a 500, not a malformed success', async () => {
    const logs = captureLogs();
    app = await testApp({ extraRoutes: routes, logStream: logs.stream });
    const res = await app.inject({ url: '/api/test/bad-shape?token=QUERYSECRET' });
    expectProblem(res.json(), 'internal', 500);
    // Regression: the framework error object carries the raw URL; it must not reach the logs.
    expect(logs.raw()).toContain('response failed schema validation');
    expect(logs.raw()).not.toContain('QUERYSECRET');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the custom header', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: { name: 'ab', count: 1 },
    });
    expectProblem(res.json(), 'request.csrf_header_missing', 403);
  });

  it('accepts them with the header', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: csrf,
      payload: { name: 'ab', count: 1 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets cookie-less endpoints (signed webhooks) opt out explicitly', async () => {
    app = await testApp({ extraRoutes: routes });
    const res = await app.inject({ method: 'POST', url: '/api/test/webhook', payload: {} });
    expect(res.json()).toEqual({ received: true });
  });
});

describe('authentication foundation', () => {
  const token = generateSessionToken();
  const actor = (
    sessionKind: 'USER' | 'ADMIN',
    roles: AuthenticatedActor['roles'] = ['CUSTOMER'],
  ): AuthenticatedActor => ({
    kind: 'user',
    userId: 'user-1',
    sessionId: 'session-1',
    sessionKind,
    roles,
    permissions: [],
  });

  function resolverFor(kind: 'USER' | 'ADMIN', roles?: AuthenticatedActor['roles']) {
    const resolve = vi.fn<SessionResolver['resolve']>(async (hash, requested) =>
      hash.equals(hashSessionToken(token)) && requested === kind ? actor(kind, roles) : null,
    );
    return { resolve };
  }

  it('anonymous requests to protected routes get 401', async () => {
    app = await testApp({ extraRoutes: routes });
    expectProblem((await app.inject({ url: '/api/test/me' })).json(), 'auth.unauthenticated', 401);
  });

  it('a valid session cookie resolves to the actor (by token hash, never the raw token)', async () => {
    const sessions = resolverFor('USER');
    app = await testApp({ extraRoutes: routes, sessions });
    const res = await app.inject({ url: '/api/test/me', cookies: { [USER_SESSION_COOKIE]: token } });
    expect(res.json()).toEqual({ userId: 'user-1' });
    const [hashArg] = sessions.resolve.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(hashArg) && hashArg.toString('utf8')).not.toBe(token);
  });

  it('malformed cookies are ignored without a lookup', async () => {
    const sessions = resolverFor('USER');
    app = await testApp({ extraRoutes: routes, sessions });
    const res = await app.inject({ url: '/api/test/me', cookies: { [USER_SESSION_COOKIE]: "' OR 1=1 --" } });
    expect(res.statusCode).toBe(401);
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('role checks return 403 for authenticated users without the role', async () => {
    app = await testApp({ extraRoutes: routes, sessions: resolverFor('USER', ['CUSTOMER']) });
    const res = await app.inject({ url: '/api/test/host-only', cookies: { [USER_SESSION_COOKIE]: token } });
    expectProblem(res.json(), 'auth.forbidden', 403);
  });

  it('admin routes accept only the admin cookie; user routes ignore it', async () => {
    app = await testApp({ extraRoutes: routes, sessions: resolverFor('ADMIN') });
    const admin = await app.inject({ url: '/api/admin/test/me', cookies: { [ADMIN_SESSION_COOKIE]: token } });
    expect(admin.json()).toEqual({ kind: 'ADMIN' });
    const userCookieOnAdmin = await app.inject({
      url: '/api/admin/test/me',
      cookies: { [USER_SESSION_COOKIE]: token },
    });
    expect(userCookieOnAdmin.statusCode).toBe(401);
    const adminCookieOnUser = await app.inject({
      url: '/api/test/me',
      cookies: { [ADMIN_SESSION_COOKIE]: token },
    });
    expect(adminCookieOnUser.statusCode).toBe(401);
  });
});

describe('logging', () => {
  it('logs route patterns with request IDs, never raw URLs, cookies or query strings', async () => {
    const logs = captureLogs();
    app = await testApp({ extraRoutes: routes, logStream: logs.stream });
    await app.inject({
      url: '/api/test/me?token=SUPERSECRETQUERY',
      cookies: { [USER_SESSION_COOKIE]: generateSessionToken() },
      headers: { authorization: 'Bearer SUPERSECRETHEADER' },
    });
    const raw = logs.raw();
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).not.toContain(USER_SESSION_COOKIE);
    const incoming = logs.entries().find((e) => e.msg === 'incoming request');
    expect(incoming).toMatchObject({ req: { method: 'GET', route: '/api/test/me' } });
    expect(incoming?.requestId).toBeTruthy();
  });

  it('redacts sensitive keys if a handler logs them', async () => {
    const logs = captureLogs();
    app = await testApp({ logStream: logs.stream });
    app.log.info({ phone: '+919999999999', user: { otp: '123456', plate: 'KA01AB1234' } }, 'oops');
    const raw = logs.raw();
    for (const secret of ['+919999999999', '123456', 'KA01AB1234']) expect(raw).not.toContain(secret);
  });
});

describe('health and docs', () => {
  it('liveness is always ok; readiness reflects the probe', async () => {
    app = await testApp({
      readiness: {
        check: async () => ({ ready: false, checks: { database: 'unavailable', migrations: 'unavailable' } }),
      },
    });
    expect((await app.inject({ url: '/api/health/live' })).json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ url: '/api/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'unavailable', migrations: 'unavailable' },
    });
  });

  it('serves an OpenAPI 3.1 document when enabled, and nothing when disabled', async () => {
    app = await testApp();
    const doc = (await app.inject({ url: '/api/docs/openapi.json' })).json() as {
      openapi: string;
      paths: object;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/api/health/ready');
    await app.close();
    app = await testApp({ env: testEnv({ API_DOCS_ENABLED: 'false' }) });
    expect((await app.inject({ url: '/api/docs/openapi.json' })).statusCode).toBe(404);
  });
});
