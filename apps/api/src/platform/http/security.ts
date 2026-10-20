import type { FastifyInstance } from 'fastify';
import { DomainError } from '../errors/domain-error.ts';
import { REQUEST_ID_HEADER } from './request-id.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set to false only for endpoints that never rely on cookies (e.g. signed provider webhooks). */
    csrf?: boolean;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'fetch';

export function registerSecurity(app: FastifyInstance, options: { hsts: boolean }): void {
  // CSRF (architecture.md §9): cookie sessions + SameSite=Lax, plus a custom header that a cross-site
  // form or image cannot set without a CORS preflight (which this API never grants).
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE_METHODS.has(request.method) || request.routeOptions.config.csrf === false) return;
    if (request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new DomainError({
        code: 'request.csrf_header_missing',
        status: 403,
        title: 'Request rejected',
        detail: `State-changing requests must send the ${CSRF_HEADER} header.`,
      });
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (options.hsts) {
      reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    }
    // API responses are personalised or time-sensitive (availability); never cache unless a route opts in.
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
  });
}
