import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { ADMIN_PERMISSIONS } from '../../../platform/auth/actor.ts';
import { actorOf, requirePermission } from '../../../platform/auth/authentication.ts';
import { ADMIN_SESSION_COOKIE } from '../../../platform/auth/session-token.ts';
import type { AuthService } from '../application/auth-service.ts';
import type { ProfileService } from '../application/profile-service.ts';
import { revokeSession } from '../application/sessions.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';
import { clearSessionCookie, profileSchema, requestContext, setSessionCookie } from './routes.ts';

const adminProfileSchema = profileSchema.extend({ permissions: z.array(z.enum(ADMIN_PERMISSIONS)) });

/** Admin console authentication (separate origin and cookie; OTP + mandatory TOTP). Mounted under /api/admin. */
export const adminIdentityRoutes: FastifyPluginAsync<{
  auth: AuthService;
  profiles: ProfileService;
  db: Kysely<IdentityDb>;
}> = async (app, { auth, profiles, db }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/otp/request',
    {
      schema: {
        tags: ['admin-auth'],
        body: z.object({ phone: z.string().max(32) }),
        response: {
          202: z.object({ challengeId: z.uuid(), expiresAt: z.date(), resendAfterSeconds: z.number().int() }),
        },
      },
    },
    async (request, reply) =>
      reply
        .status(202)
        .send(
          await auth.requestOtp(
            { phone: request.body.phone, purpose: 'ADMIN_LOGIN' },
            requestContext(request),
          ),
        ),
  );

  r.post(
    '/auth/otp/verify',
    {
      schema: {
        tags: ['admin-auth'],
        body: z.object({ challengeId: z.string().max(64), code: z.string().regex(/^\d{6}$/) }),
        response: {
          200: z.object({
            status: z.literal('TOTP_REQUIRED'),
            ticket: z.string(),
            ticketExpiresAt: z.date(),
          }),
        },
      },
    },
    async (request) => {
      const result = await auth.verifyOtp(
        { ...request.body, purpose: 'ADMIN_LOGIN' },
        requestContext(request),
      );
      if (result.status !== 'TOTP_REQUIRED') throw new Error('unexpected admin verification result');
      return {
        status: 'TOTP_REQUIRED' as const,
        ticket: result.ticket,
        ticketExpiresAt: result.ticketExpiresAt,
      };
    },
  );

  r.post(
    '/auth/totp',
    {
      schema: {
        tags: ['admin-auth'],
        body: z.object({ ticket: z.string().max(200), code: z.string().regex(/^\d{6}$/) }),
        response: { 200: z.object({ status: z.literal('AUTHENTICATED'), admin: adminProfileSchema }) },
      },
    },
    async (request, reply) => {
      const { userId, session } = await auth.verifyAdminTotp(request.body, requestContext(request));
      setSessionCookie(reply, ADMIN_SESSION_COOKIE, session);
      return { status: 'AUTHENTICATED' as const, admin: await profiles.getAdminProfile(userId) };
    },
  );

  r.post('/auth/logout', { schema: { tags: ['admin-auth'] } }, async (request, reply) => {
    if (request.actor.kind === 'user') {
      await revokeSession(db, {
        sessionId: request.actor.sessionId,
        userId: request.actor.userId,
        reason: 'LOGOUT',
      });
    }
    clearSessionCookie(reply, ADMIN_SESSION_COOKIE);
    return reply.status(204).send();
  });

  r.get(
    '/me',
    {
      // Any admin permission suffices to see one's own profile.
      preHandler: requirePermission(...ADMIN_PERMISSIONS),
      schema: { tags: ['admin'], response: { 200: adminProfileSchema } },
    },
    async (request) => profiles.getAdminProfile(actorOf(request).userId),
  );
};
