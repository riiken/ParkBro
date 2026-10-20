import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import type { AccessService } from '../application/access-service.ts';

const accessView = z.object({
  status: z.enum(['ISSUED', 'ACTIVE', 'USED', 'EXPIRED', 'REVOKED']),
  code: z.string().nullable(),
  plate: z.string(),
  unitLabel: z.string().nullable(),
  validFrom: z.date(),
  validUntil: z.date(),
  enteredAt: z.date().nullable(),
  canCheckIn: z.boolean(),
  passToken: z.string().nullable(),
});
const bookingParams = z.object({ bookingId: z.uuid() });
const gateParams = z.object({ token: z.string().min(1).max(100) });

/** Customer access (C-12) and the public surfaces: driver pass and guard link (G-01). */
export const accessRoutes: FastifyPluginAsync<{ access: AccessService }> = async (app, { access }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/bookings/:bookingId/access',
    {
      preHandler: requireUser,
      schema: { tags: ['access'], params: bookingParams, response: { 200: accessView } },
    },
    async (request) => access.customerAccess(actorOf(request).userId, request.params.bookingId),
  );
  r.post(
    '/v1/bookings/:bookingId/access/reissue',
    {
      preHandler: requireUser,
      schema: { tags: ['access'], params: bookingParams, response: { 200: accessView } },
    },
    async (request) => access.reissue(actorOf(request).userId, request.params.bookingId, request.id),
  );
  r.post(
    '/v1/bookings/:bookingId/check-in',
    {
      preHandler: requireUser,
      schema: { tags: ['access'], params: bookingParams, response: { 200: accessView } },
    },
    async (request) =>
      access.checkInByCustomer(actorOf(request).userId, request.params.bookingId, request.id),
  );

  // Driver pass: no account; the signed token is the authority (time-limited, revoked with the booking).
  r.get(
    '/v1/access/pass/:token',
    {
      schema: {
        tags: ['access'],
        params: gateParams,
        response: {
          200: accessView.extend({ address: z.string().nullable(), instructions: z.string().nullable() }),
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return access.passView(request.params.token, request.ip);
    },
  );

  // Guard link (no account): per-gate token, rate-limited; answers carry no personal data beyond the plate.
  r.get(
    '/v1/gate/:token',
    {
      schema: {
        tags: ['access'],
        params: gateParams,
        response: { 200: z.object({ label: z.string(), expiresAt: z.date() }) },
      },
    },
    async (request) => access.gateInfo(request.params.token),
  );
  r.post(
    '/v1/gate/:token/lookup',
    {
      schema: {
        tags: ['access'],
        params: gateParams,
        body: z
          .object({
            plate: z.string().max(20).optional(),
            code: z.string().max(12).optional(),
            pass: z.string().max(400).optional(),
          })
          .refine(
            (b) => [b.plate, b.code, b.pass].filter(Boolean).length === 1,
            'Enter the vehicle number or the code',
          ),
        response: {
          200: z.union([
            z.object({ valid: z.literal(false), reason: z.literal('NO_BOOKING_NOW') }),
            z.object({
              valid: z.literal(true),
              unitLabel: z.string().nullable(),
              validUntil: z.date(),
              expectedPlate: z.string(),
              alreadyEntered: z.boolean(),
              entryTicket: z.string(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return access.guardLookup(request.params.token, request.body);
    },
  );
  r.post(
    '/v1/gate/:token/entries',
    {
      schema: {
        tags: ['access'],
        params: gateParams,
        body: z.object({ ticket: z.string().min(10).max(600) }),
        response: { 200: z.object({ entered: z.boolean() }) },
      },
    },
    async (request) => access.guardEntry(request.params.token, request.body.ticket, request.id),
  );
};

const gateView = z.object({
  id: z.uuid(),
  label: z.string(),
  status: z.enum(['ACTIVE', 'REVOKED']),
  expiresAt: z.date(),
  createdAt: z.date(),
});
const createdGate = z.object({
  id: z.uuid(),
  label: z.string(),
  token: z.string(),
  path: z.string(),
  expiresAt: z.date(),
});
const logView = z.array(
  z.object({
    kind: z.string(),
    source: z.string(),
    method: z.string().nullable(),
    detail: z.string().nullable(),
    gate: z.string().nullable(),
    plateLast4: z.string().nullable(),
    unitLabel: z.string().nullable(),
    at: z.date(),
  }),
);
const propertyParams = z.object({ propertyId: z.uuid() });

/** Property owners manage guard links and read the access log (P-04, P-06 for independent properties). */
export const accessHostRoutes: FastifyPluginAsync<{ access: AccessService; hosts: HostService }> = async (
  app,
  { access, hosts },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/host/properties/:propertyId/gates',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: propertyParams, response: { 200: z.array(gateView) } },
    },
    async (request) =>
      access.hostGates.list(
        await requireHostAccess(hosts, request, { forWrite: false }),
        request.params.propertyId,
      ),
  );
  r.post(
    '/v1/host/properties/:propertyId/gates',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: propertyParams,
        body: z.object({ label: z.string().trim().min(1).max(40) }),
        response: { 201: createdGate },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await access.hostGates.create(
            await requireHostAccess(hosts, request, { forWrite: true }),
            request.params.propertyId,
            request.body.label,
            request.id,
          ),
        ),
  );
  r.delete(
    '/v1/host/properties/:propertyId/gates/:gateId',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: propertyParams.extend({ gateId: z.uuid() }) },
    },
    async (request, reply) => {
      await access.hostGates.revoke(
        await requireHostAccess(hosts, request, { forWrite: false }),
        request.params.propertyId,
        request.params.gateId,
        request.id,
      );
      return reply.status(204).send();
    },
  );
  r.get(
    '/v1/host/properties/:propertyId/access-log',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: propertyParams, response: { 200: logView } },
    },
    async (request) =>
      access.hostGates.log(
        await requireHostAccess(hosts, request, { forWrite: false }),
        request.params.propertyId,
      ),
  );
};

/** Platform admins manage gates for societies until the property-admin console (Phase 20). */
export const accessAdminRoutes: FastifyPluginAsync<{ access: AccessService }> = async (app, { access }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('TRUST_SAFETY');
  r.post(
    '/v1/properties/:propertyId/gates',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: propertyParams,
        body: z.object({ label: z.string().trim().min(1).max(40) }),
        response: { 201: createdGate },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await access.adminGates.create(
            actorOf(request),
            request.params.propertyId,
            request.body.label,
            request.id,
          ),
        ),
  );
  r.get(
    '/v1/properties/:propertyId/access-log',
    { preHandler: guard, schema: { tags: ['admin'], params: propertyParams, response: { 200: logView } } },
    async (request) => access.adminGates.log(request.params.propertyId),
  );
};
