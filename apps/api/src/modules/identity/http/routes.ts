import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { actorOf, requireUser } from '../../../platform/auth/authentication.ts';
import { SESSION_COOKIE_OPTIONS, USER_SESSION_COOKIE } from '../../../platform/auth/session-token.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import type { AuthService, RequestContext } from '../application/auth-service.ts';
import { LOCALES, type ProfileService } from '../application/profile-service.ts';
import { listActiveSessions, revokeSession, type CreatedSession } from '../application/sessions.ts';
import { CURRENT_NOTICE_VERSION } from '../domain/policy.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';

export const profileSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  phoneMasked: z.string(),
  locale: z.enum(LOCALES),
  roles: z.array(z.string()),
  createdAt: z.date(),
});

const authenticatedSchema = z.object({ status: z.literal('AUTHENTICATED'), user: profileSchema });
const displayName = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(60, 'Use at most 60 characters')
  .refine((v) => !/[<>]/.test(v), 'Name contains characters that are not allowed');
const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export function requestContext(request: FastifyRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'], requestId: request.id };
}

export function setSessionCookie(reply: FastifyReply, cookieName: string, session: CreatedSession) {
  reply.setCookie(cookieName, session.token, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: session.cookieMaxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, cookieName: string) {
  reply.clearCookie(cookieName, SESSION_COOKIE_OPTIONS);
}

export const identityRoutes: FastifyPluginAsync<{
  auth: AuthService;
  profiles: ProfileService;
  db: Kysely<IdentityDb>;
}> = async (app, { auth, profiles, db }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/auth/notice',
    { schema: { tags: ['auth'], response: { 200: z.object({ version: z.string() }) } } },
    async () => ({ version: CURRENT_NOTICE_VERSION }),
  );

  r.post(
    '/v1/auth/otp/request',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ phone: z.string().max(32) }),
        response: {
          202: z.object({ challengeId: z.uuid(), expiresAt: z.date(), resendAfterSeconds: z.number().int() }),
        },
      },
    },
    async (request, reply) => {
      const result = await auth.requestOtp(
        { phone: request.body.phone, purpose: 'USER_LOGIN' },
        requestContext(request),
      );
      return reply.status(202).send(result);
    },
  );

  r.post(
    '/v1/auth/otp/verify',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ challengeId: z.string().max(64), code: otpCode }),
        response: {
          200: z.discriminatedUnion('status', [
            authenticatedSchema,
            z.object({
              status: z.literal('REGISTRATION_REQUIRED'),
              ticket: z.string(),
              ticketExpiresAt: z.date(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      const result = await auth.verifyOtp(
        { ...request.body, purpose: 'USER_LOGIN' },
        requestContext(request),
      );
      if (result.status === 'AUTHENTICATED') {
        setSessionCookie(reply, USER_SESSION_COOKIE, result.session);
        return { status: 'AUTHENTICATED' as const, user: await profiles.getProfile(result.userId) };
      }
      if (result.status === 'REGISTRATION_REQUIRED') {
        return {
          status: 'REGISTRATION_REQUIRED' as const,
          ticket: result.ticket,
          ticketExpiresAt: result.ticketExpiresAt,
        };
      }
      throw errors.notFound(); // TOTP_REQUIRED cannot happen for USER_LOGIN
    },
  );

  r.post(
    '/v1/auth/register',
    {
      schema: {
        tags: ['auth'],
        body: z.object({
          ticket: z.string().max(200),
          displayName,
          ageAttested: z.literal(true, { error: 'You must be 18 or older to use the service' }),
          acceptedNoticeVersion: z.string().max(40),
        }),
        response: { 201: authenticatedSchema },
      },
    },
    async (request, reply) => {
      const { userId, session } = await auth.register(request.body, requestContext(request));
      setSessionCookie(reply, USER_SESSION_COOKIE, session);
      return reply
        .status(201)
        .send({ status: 'AUTHENTICATED' as const, user: await profiles.getProfile(userId) });
    },
  );

  r.post('/v1/auth/logout', { schema: { tags: ['auth'] } }, async (request, reply) => {
    // Idempotent: signing out without a session still clears the cookie.
    if (request.actor.kind === 'user') {
      await revokeSession(db, {
        sessionId: request.actor.sessionId,
        userId: request.actor.userId,
        reason: 'LOGOUT',
      });
    }
    clearSessionCookie(reply, USER_SESSION_COOKIE);
    return reply.status(204).send();
  });

  r.get(
    '/v1/me',
    { preHandler: requireUser, schema: { tags: ['me'], response: { 200: profileSchema } } },
    async (request) => profiles.getProfile(actorOf(request).userId),
  );

  r.patch(
    '/v1/me',
    {
      preHandler: requireUser,
      schema: {
        tags: ['me'],
        body: z
          .object({ displayName: displayName.optional(), locale: z.enum(LOCALES).optional() })
          .strict()
          .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
        response: { 200: profileSchema },
      },
    },
    async (request) => profiles.updateProfile(actorOf(request).userId, request.body, request.id),
  );

  r.get(
    '/v1/me/sessions',
    {
      preHandler: requireUser,
      schema: {
        tags: ['me'],
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              current: z.boolean(),
              createdAt: z.date(),
              lastSeenAt: z.date(),
              userAgent: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const sessions = await listActiveSessions(db, actor.userId);
      return sessions
        .filter((s) => s.kind === 'USER')
        .map((s) => ({
          id: s.id,
          current: s.id === actor.sessionId,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at as Date,
          userAgent: s.user_agent,
        }));
    },
  );

  r.delete(
    '/v1/me/sessions/:sessionId',
    { preHandler: requireUser, schema: { tags: ['me'], params: z.object({ sessionId: z.uuid() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      // Scoped to the actor's own sessions: anything else is "not found" (domain-model §4 ownership).
      const revoked = await revokeSession(db, {
        sessionId: request.params.sessionId,
        userId: actor.userId,
        reason: 'USER_REVOKED',
      });
      if (!revoked) throw errors.notFound();
      if (request.params.sessionId === actor.sessionId) clearSessionCookie(reply, USER_SESSION_COOKIE);
      return reply.status(204).send();
    },
  );
};
