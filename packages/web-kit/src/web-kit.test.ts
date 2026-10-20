import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, apiRequest } from './api-client.ts';
import { safeNextPath } from './navigation.ts';

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    assert.equal(safeNextPath('/account'), '/account');
    assert.equal(safeNextPath('/listing/1?x=2#y'), '/listing/1?x=2#y');
  });
  it('rejects open-redirect attempts', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/a\u0000b',
      '',
      null,
    ]) {
      assert.equal(safeNextPath(bad), '/account', String(bad));
    }
  });
});

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers })) as typeof fetch;

describe('apiRequest', () => {
  it('sends the CSRF header, same-origin credentials and JSON', async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await apiRequest('/api/x', { method: 'POST', body: { a: 1 } }, fake), { ok: true });
    assert.equal((seen?.headers as Record<string, string>)['x-requested-with'], 'fetch');
    assert.equal(seen?.credentials, 'same-origin');
    assert.equal(seen?.body, '{"a":1}');
  });

  it('maps problem+json to ApiError with field errors and Retry-After', async () => {
    const problem = {
      type: '/problems/request.invalid',
      title: 'Invalid request',
      status: 400,
      code: 'request.invalid',
      requestId: 'r1',
      errors: [{ path: 'body/displayName', message: 'Enter your name' }],
    };
    await assert.rejects(
      apiRequest('/api/x', {}, respond(400, problem, { 'retry-after': '12' })),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'request.invalid');
        assert.equal(e.fieldErrors.displayName, 'Enter your name');
        assert.equal(e.retryAfterSeconds, 12);
        return true;
      },
    );
  });

  it('maps non-problem failures and network errors to stable codes', async () => {
    await assert.rejects(
      apiRequest('/api/x', {}, respond(502, { nope: 1 })),
      (e: unknown) => (e as ApiError).code === 'internal',
    );
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(
      apiRequest('/api/x', {}, offline),
      (e: unknown) => (e as ApiError).code === 'network.unavailable',
    );
  });

  it('returns undefined for 204', async () => {
    assert.equal(await apiRequest('/api/x', { method: 'DELETE' }, respond(204, undefined)), undefined);
  });
});
