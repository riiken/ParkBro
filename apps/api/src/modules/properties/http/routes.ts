import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission, requireUser, actorOf } from '../../../platform/auth/authentication.ts';
import { DomainError } from '../../../platform/errors/domain-error.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import type { PropertyService } from '../application/property-service.ts';
import { PARTICIPATION_STATUSES } from '../domain/participation.ts';
import { adminPropertySchema, hostPropertySchema, propertyInputShape } from './schemas.ts';

export const propertyHostRoutes: FastifyPluginAsync<{
  properties: PropertyService;
  hosts: HostService;
}> = async (app, { properties, hosts }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/host/properties',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        body: z.object({
          // Societies are onboarded by the platform with the committee's consent (D-009, PJ-1).
          kind: z.enum(['INDEPENDENT_HOUSE', 'COMMERCIAL', 'OFFICE', 'OTHER']),
          ...propertyInputShape,
        }),
        response: { 201: hostPropertySchema },
      },
    },
    async (request, reply) => {
      const host = await requireHostAccess(hosts, request, { forWrite: true });
      return reply.status(201).send(await properties.createHostProperty(host, request.body, request.id));
    },
  );

  r.get(
    '/v1/host/properties',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: z.array(hostPropertySchema) } } },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return properties.listHostProperties(host.hostAccountId);
    },
  );

  r.get(
    '/v1/host/properties/:propertyId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: z.object({ propertyId: z.uuid() }),
        response: { 200: hostPropertySchema },
      },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return properties.getHostProperty(request.params.propertyId, host.hostAccountId);
    },
  );

  r.patch(
    '/v1/host/properties/:propertyId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: z.object({ propertyId: z.uuid() }),
        body: z
          .object({
            version: z.number().int(),
            address: propertyInputShape.address.optional(),
            latitude: propertyInputShape.latitude.optional(),
            longitude: propertyInputShape.longitude.optional(),
            areaLabel: propertyInputShape.areaLabel.optional(),
            timezone: z.string().max(64).optional(),
          })
          .strict()
          .refine(
            (b) => (b.latitude === undefined) === (b.longitude === undefined),
            'Send latitude and longitude together',
          ),
        response: { 200: hostPropertySchema },
      },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: true });
      return properties.updateHostProperty(request.params.propertyId, host, request.body, request.id);
    },
  );
};

/** Society onboarding and governance (PJ-1). API only until the admin console (Phase 20). Mounted under /admin. */
export const propertyAdminRoutes: FastifyPluginAsync<{
  properties: PropertyService;
  hosts: HostService;
}> = async (app, { properties, hosts }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('TRUST_SAFETY');

  r.get(
    '/v1/properties',
    {
      preHandler: requirePermission('TRUST_SAFETY', 'SUPPORT'),
      schema: {
        tags: ['admin'],
        querystring: z.object({
          q: z.string().trim().max(60).optional(),
          kind: z
            .enum(['APARTMENT_SOCIETY', 'INDEPENDENT_HOUSE', 'COMMERCIAL', 'OFFICE', 'OTHER'])
            .optional(),
          participation: z.enum(PARTICIPATION_STATUSES).optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => properties.adminList(request.query),
  );

  r.post(
    '/properties/societies',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        body: z.object({
          ...propertyInputShape,
          displayName: z.string().trim().min(2).max(80).nullable().default(null),
          outsiderCap: z.number().int().min(1).max(500).nullable().default(null),
        }),
        response: { 201: adminPropertySchema },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(await properties.createSociety({ userId: actorOf(request).userId }, request.body, request.id)),
  );

  r.get(
    '/properties/:propertyId',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: z.object({ propertyId: z.uuid() }),
        response: { 200: adminPropertySchema },
      },
    },
    async (request) =>
      properties.adminView(request.params.propertyId, {
        adminId: actorOf(request).userId,
        requestId: request.id,
      }),
  );

  r.post(
    '/properties/:propertyId/participation',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: z.object({ propertyId: z.uuid() }),
        body: z.object({
          status: z.enum(PARTICIPATION_STATUSES).exclude(['NOT_REQUIRED']),
          reason: z.string().trim().min(3).max(300),
        }),
        response: { 200: adminPropertySchema },
      },
    },
    async (request) =>
      properties.setParticipation(
        { userId: actorOf(request).userId },
        request.params.propertyId,
        request.body.status,
        request.body.reason,
        request.id,
      ),
  );

  r.post(
    '/properties/:propertyId/member-hosts',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: z.object({ propertyId: z.uuid() }),
        body: z.object({ hostAccountId: z.uuid() }),
        response: { 200: adminPropertySchema },
      },
    },
    async (request) => {
      if (!(await hosts.hostAccountExists(request.body.hostAccountId))) {
        throw new DomainError({ code: 'host.not_found', status: 404, title: 'Host account not found' });
      }
      return properties.addMemberHost(
        { userId: actorOf(request).userId },
        request.params.propertyId,
        request.body.hostAccountId,
        request.id,
      );
    },
  );

  r.delete(
    '/properties/:propertyId/member-hosts/:hostAccountId',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: z.object({ propertyId: z.uuid(), hostAccountId: z.uuid() }),
        response: { 200: adminPropertySchema },
      },
    },
    async (request) =>
      properties.revokeMemberHost(
        { userId: actorOf(request).userId },
        request.params.propertyId,
        request.params.hostAccountId,
        request.id,
      ),
  );
};
