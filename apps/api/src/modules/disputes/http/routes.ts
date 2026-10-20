import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import type { DisputeService } from '../application/dispute-service.ts';
import { CATEGORIES, OUTCOMES } from '../domain/dispute.ts';
import { EVIDENCE_TYPES } from '../infrastructure/evidence-images.ts';

const MAX_UPLOAD = 10 * 1024 * 1024;
const disputeParams = z.object({ disputeId: z.uuid() });
const text = (max: number) => z.string().trim().min(1).max(max);

/** Parties (customer or host members) of a booking: open, discuss, add photos (C-18). */
export const disputeRoutes: FastifyPluginAsync<{ disputes: DisputeService }> = async (app, { disputes }) => {
  app.addContentTypeParser(
    [...EVIDENCE_TYPES],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
    (_req, body, done) => done(null, body),
  );
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/bookings/:bookingId/disputes',
    { preHandler: requireUser, schema: { tags: ['disputes'], params: z.object({ bookingId: z.uuid() }) } },
    async (request) => disputes.forBooking(actorOf(request).userId, request.params.bookingId),
  );
  r.post(
    '/v1/bookings/:bookingId/disputes',
    {
      preHandler: requireUser,
      schema: {
        tags: ['disputes'],
        params: z.object({ bookingId: z.uuid() }),
        body: z.object({
          category: z.enum(CATEGORIES),
          description: text(2000),
          requestedOutcome: z.enum(['REFUND', 'PARTIAL_REFUND', 'COMPENSATION', 'REVIEW_ONLY', 'OTHER']),
        }),
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await disputes.open(actorOf(request).userId, request.params.bookingId, request.body, request.id),
        ),
  );
  r.get(
    '/v1/disputes/:disputeId',
    { preHandler: requireUser, schema: { tags: ['disputes'], params: disputeParams } },
    async (request) => disputes.partyView(actorOf(request).userId, request.params.disputeId),
  );
  r.post(
    '/v1/disputes/:disputeId/messages',
    {
      preHandler: requireUser,
      schema: { tags: ['disputes'], params: disputeParams, body: z.object({ body: text(2000) }) },
    },
    async (request) =>
      disputes.message(actorOf(request).userId, request.params.disputeId, request.body.body, request.id),
  );
  r.post(
    '/v1/disputes/:disputeId/evidence',
    { preHandler: requireUser, bodyLimit: MAX_UPLOAD, schema: { tags: ['disputes'], params: disputeParams } },
    async (request: FastifyRequest<{ Params: { disputeId: string } }>, reply) => {
      if (!Buffer.isBuffer(request.body)) return reply.status(415).send();
      return reply
        .status(201)
        .send(
          await disputes.addEvidence(
            { userId: actorOf(request).userId, admin: false },
            request.params.disputeId,
            request.body,
            request.id,
          ),
        );
    },
  );
  r.get(
    '/v1/dispute-evidence/:evidenceId',
    { preHandler: requireUser, schema: { tags: ['disputes'], params: z.object({ evidenceId: z.uuid() }) } },
    async (request, reply) => {
      const data = await disputes.evidenceFile(
        { userId: actorOf(request).userId, admin: false },
        request.params.evidenceId,
      );
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );
};

/** Admin queue and decisions (A-03). Resolution only through an admin session; HIGH risk only TRUST_SAFETY. */
export const disputeAdminRoutes: FastifyPluginAsync<{ disputes: DisputeService }> = async (
  app,
  { disputes },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('SUPPORT', 'TRUST_SAFETY');
  const admin = (request: FastifyRequest) => {
    const a = actorOf(request);
    return { userId: a.userId, permissions: a.permissions };
  };
  r.get('/v1/disputes', { preHandler: guard, schema: { tags: ['admin'] } }, async () => disputes.queue());
  r.get(
    '/v1/disputes/:disputeId',
    { preHandler: guard, schema: { tags: ['admin'], params: disputeParams } },
    async (request) => disputes.adminView(request.params.disputeId),
  );
  r.post(
    '/v1/disputes/:disputeId/:action',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: disputeParams.extend({ action: z.enum(['review', 'request-info', 'escalate', 'close']) }),
        body: z
          .object({ note: z.string().trim().max(2000).nullable().default(null) })
          .default({ note: null }),
      },
    },
    async (request) => {
      const action = (
        { review: 'REVIEW', 'request-info': 'REQUEST_INFO', escalate: 'ESCALATE', close: 'CLOSE' } as const
      )[request.params.action];
      return disputes.adminAct(
        admin(request),
        request.params.disputeId,
        action,
        request.body.note,
        request.id,
      );
    },
  );
  r.post(
    '/v1/disputes/:disputeId/resolve',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: disputeParams,
        body: z
          .object({
            outcome: z.enum(OUTCOMES),
            refundPaise: z.number().int().min(1).optional(),
            note: text(2000),
          })
          .refine(
            (b) => (b.outcome === 'REFUND_PARTIAL') === (b.refundPaise !== undefined),
            'A partial refund needs an amount',
          ),
      },
    },
    async (request) => disputes.resolve(admin(request), request.params.disputeId, request.body, request.id),
  );
  r.get(
    '/v1/dispute-evidence/:evidenceId',
    { preHandler: guard, schema: { tags: ['admin'], params: z.object({ evidenceId: z.uuid() }) } },
    async (request, reply) => {
      const data = await disputes.evidenceFile(
        { userId: actorOf(request).userId, admin: true },
        request.params.evidenceId,
      );
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );
};
