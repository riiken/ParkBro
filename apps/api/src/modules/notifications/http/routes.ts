import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requireUser } from '../../../platform/auth/authentication.ts';
import type { NotificationService } from '../application/notification-service.ts';

const prefs = z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean(), push: z.boolean() });

/** In-app inbox and channel preferences (C-19). */
export const notificationRoutes: FastifyPluginAsync<{ notifications: NotificationService }> = async (
  app,
  { notifications },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/me/notifications',
    {
      preHandler: requireUser,
      schema: {
        tags: ['me'],
        response: {
          200: z.object({
            unread: z.number().int(),
            items: z.array(
              z.object({
                id: z.uuid(),
                title: z.string(),
                body: z.string(),
                link: z.string().nullable(),
                category: z.enum(['CRITICAL', 'TRANSACTIONAL', 'REMINDER']),
                read: z.boolean(),
                createdAt: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => notifications.inbox(actorOf(request).userId),
  );
  r.post(
    '/v1/me/notifications/read',
    {
      preHandler: requireUser,
      schema: {
        tags: ['me'],
        body: z.object({ ids: z.array(z.uuid()).max(100).optional(), all: z.boolean().optional() }),
      },
    },
    async (request, reply) => {
      await notifications.markRead(
        actorOf(request).userId,
        request.body.all ? 'all' : (request.body.ids ?? []),
      );
      return reply.status(204).send();
    },
  );
  r.get(
    '/v1/me/notification-preferences',
    { preHandler: requireUser, schema: { tags: ['me'], response: { 200: prefs } } },
    async (request) => notifications.preferences(actorOf(request).userId),
  );
  r.put(
    '/v1/me/notification-preferences',
    { preHandler: requireUser, schema: { tags: ['me'], body: prefs.partial(), response: { 200: prefs } } },
    async (request) => notifications.setPreferences(actorOf(request).userId, request.body),
  );
};

/** Provider delivery receipts: raw signed body, no session or CSRF header. */
export const messagingWebhookRoutes: FastifyPluginAsync<{
  notifications: NotificationService;
  provider: string;
}> = async (app, { notifications, provider }) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post(`/v1/webhooks/messaging/${provider}`, { config: { csrf: false } }, async (request) =>
    notifications.handleDeliveryWebhook(String(request.body ?? ''), request.headers),
  );
};
