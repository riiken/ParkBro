import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requireUser } from '../../../platform/auth/authentication.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import { CONTACT_DETAILS_MESSAGE, findContactDetails } from '../../../platform/text/contact-details.ts';
import type { HostService } from '../application/host-service.ts';

export const hostAccountSchema = z.object({
  hostAccountId: z.uuid(),
  role: z.enum(['OWNER', 'MANAGER']),
  status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED']),
  kind: z.enum(['INDIVIDUAL', 'BUSINESS']),
  displayName: z.string(),
});

export const hostRoutes: FastifyPluginAsync<{ hosts: HostService }> = async (app, { hosts }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/host/account',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        body: z.object({
          kind: z.enum(['INDIVIDUAL', 'BUSINESS']).default('INDIVIDUAL'),
          displayName: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .refine((v) => findContactDetails(v) === null, CONTACT_DETAILS_MESSAGE),
        }),
        response: { 201: hostAccountSchema },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await hosts.becomeHost(actorOf(request).userId, request.body, request.id)),
  );

  r.get(
    '/v1/host/account',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: hostAccountSchema } } },
    async (request) => {
      const access = await hosts.hostAccessFor(actorOf(request).userId);
      if (!access) throw errors.notFound('You are not a host yet.');
      return access;
    },
  );
};
