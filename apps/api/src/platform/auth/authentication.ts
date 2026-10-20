import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors } from '../errors/domain-error.ts';
import {
  ANONYMOUS,
  type Actor,
  type AdminPermission,
  type AuthenticatedActor,
  type Role,
  type SessionResolver,
} from './actor.ts';
import {
  ADMIN_SESSION_COOKIE,
  USER_SESSION_COOKIE,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.ts';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

export const ADMIN_API_PREFIX = '/api/admin/';

/** Marks the guard preHandlers so the route-security test can prove every non-public route has one. */
export const AUTH_GUARD = Symbol.for('parkbro.authGuard');
const guard = <F extends (request: FastifyRequest) => Promise<void>>(
  fn: F,
  kind: 'user' | 'role' | 'admin',
): F => Object.assign(fn, { [AUTH_GUARD]: kind });

/**
 * Resolves `request.actor` from the session cookie on every request.
 * Admin API routes accept only the admin cookie and admin sessions; all other routes only the user cookie
 * (separate origins and cookies per architecture.md §9). Authorisation itself lives in the owning module.
 */
export async function registerAuthentication(app: FastifyInstance, resolver: SessionResolver): Promise<void> {
  await app.register(cookie);
  // Fastify 5 forbids shared object references as decorator defaults; every request sets it in onRequest.
  app.decorateRequest('actor', null as never);

  app.addHook('onRequest', async (request) => {
    const isAdminRoute = request.url.startsWith(ADMIN_API_PREFIX);
    const token = request.cookies[isAdminRoute ? ADMIN_SESSION_COOKIE : USER_SESSION_COOKIE];
    request.actor = ANONYMOUS;
    if (token === undefined || !isWellFormedSessionToken(token)) return;
    const actor = await resolver.resolve(hashSessionToken(token), isAdminRoute ? 'ADMIN' : 'USER');
    if (actor) request.actor = actor;
  });
}

/** preHandler: the request must carry a valid session. */
export const requireUser = guard(async (request: FastifyRequest): Promise<void> => {
  if (request.actor.kind !== 'user') throw errors.unauthenticated();
}, 'user');

/** preHandler factory: the request must carry a valid session holding one of the roles. */
export function requireRole(...roles: Role[]) {
  return guard(async (request: FastifyRequest): Promise<void> => {
    if (request.actor.kind !== 'user') throw errors.unauthenticated();
    const held = request.actor.roles;
    if (!roles.some((role) => held.includes(role))) throw errors.forbidden();
  }, 'role');
}

/**
 * preHandler factory: an ADMIN session holding one of the permissions (SUPER_ADMIN holds all).
 * A user session is never sufficient, even for a platform admin (separate origin, cookie and 2FA).
 */
export function requirePermission(...permissions: AdminPermission[]) {
  return guard(async (request: FastifyRequest): Promise<void> => {
    const actor = request.actor;
    if (actor.kind !== 'user' || actor.sessionKind !== 'ADMIN') throw errors.unauthenticated();
    if (actor.permissions.includes('SUPER_ADMIN')) return;
    if (!permissions.some((p) => actor.permissions.includes(p))) throw errors.forbidden();
  }, 'admin');
}

/** Resource ownership (domain-model §4): someone else's resource is reported as not found, never forbidden. */
export function assertOwner(request: FastifyRequest, ownerUserId: string): void {
  if (request.actor.kind !== 'user' || request.actor.userId !== ownerUserId) throw errors.notFound();
}

export function actorOf(request: FastifyRequest): AuthenticatedActor {
  if (request.actor.kind !== 'user') throw errors.unauthenticated();
  return request.actor;
}
