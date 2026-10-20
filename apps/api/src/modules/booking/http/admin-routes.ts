import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission } from '../../../platform/auth/authentication.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import type { BookingService } from '../application/booking-service.ts';
import { BOOKING_STATUSES } from '../domain/state-machine.ts';

/** Admin bookings (Phase 20, A-02): search, detail with history, platform cancellation with a reason. */
export const bookingAdminRoutes: FastifyPluginAsync<{ bookings: BookingService }> = async (
  app,
  { bookings },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = requirePermission('SUPPORT', 'TRUST_SAFETY', 'FINANCE');
  r.get(
    '/v1/bookings',
    {
      preHandler: read,
      schema: {
        tags: ['admin'],
        querystring: z.object({
          status: z.enum(BOOKING_STATUSES).optional(),
          q: z.string().trim().max(36).optional(),
          hostAccountId: z.uuid().optional(),
          customerId: z.uuid().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => bookings.adminList(request.query),
  );
  r.get(
    '/v1/bookings/:bookingId',
    { preHandler: read, schema: { tags: ['admin'], params: z.object({ bookingId: z.uuid() }) } },
    async (request) => bookings.adminView(request.params.bookingId),
  );
  r.post(
    '/v1/bookings/:bookingId/cancel',
    {
      preHandler: requirePermission('SUPPORT', 'TRUST_SAFETY'),
      schema: {
        tags: ['admin'],
        params: z.object({ bookingId: z.uuid() }),
        body: z.object({ reason: z.string().trim().min(5).max(300) }),
      },
    },
    async (request) => {
      const refund = await bookings.cancelByPlatform(
        actorOf(request).userId,
        request.params.bookingId,
        request.body.reason,
        request.id,
      );
      return { refundPaise: refund.refundPaise };
    },
  );
};
