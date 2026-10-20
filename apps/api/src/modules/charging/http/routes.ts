import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requireUser } from '../../../platform/auth/authentication.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import type { ChargingService } from '../application/charging-service.ts';
import { FAULT_REASONS, SESSION_STATUSES } from '../domain/session.ts';

const params = z.object({ bookingId: z.uuid() });
const sessionView = z.object({
  bookingId: z.uuid(),
  status: z.enum(SESSION_STATUSES),
  charger: z.object({
    connectors: z.array(z.string()),
    currentType: z.enum(['AC', 'DC']),
    powerKw: z.number(),
    speed: z.enum(['SLOW', 'FAST', 'RAPID']),
    cableProvided: z.boolean(),
    integration: z.enum(['MANUAL']),
  }),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  energyKwh: z.number().nullable(),
  metering: z.enum(['NONE', 'HOST_REPORTED', 'CHARGER_API']),
  maxEnergyKwhForBooking: z.number(),
  fault: z.object({ reason: z.enum(FAULT_REASONS), note: z.string().nullable() }).nullable(),
  actions: z.object({ canStart: z.boolean(), canStop: z.boolean(), canReportFault: z.boolean() }),
});

/** Charging session API (Phase 14, ux C-20). Scoped to the booking's customer, or its host (read-only). */
export const chargingRoutes: FastifyPluginAsync<{ charging: ChargingService; hosts: HostService }> = async (
  app,
  { charging, hosts },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const schema = (extra: object = {}) => ({
    tags: ['charging'],
    params,
    response: { 200: sessionView },
    ...extra,
  });

  r.get('/v1/bookings/:bookingId/charging', { preHandler: requireUser, schema: schema() }, async (request) =>
    charging.customerView(actorOf(request).userId, request.params.bookingId),
  );
  r.post(
    '/v1/bookings/:bookingId/charging/start',
    { preHandler: requireUser, schema: schema() },
    async (request) => charging.start(actorOf(request).userId, request.params.bookingId, request.id),
  );
  r.post(
    '/v1/bookings/:bookingId/charging/stop',
    { preHandler: requireUser, schema: schema() },
    async (request) => charging.stop(actorOf(request).userId, request.params.bookingId, request.id),
  );
  r.post(
    '/v1/bookings/:bookingId/charging/fault',
    {
      preHandler: requireUser,
      schema: schema({
        body: z.object({
          reason: z.enum(FAULT_REASONS),
          note: z.string().trim().max(500).nullable().default(null),
        }),
      }),
    },
    async (request) => {
      const body = request.body as { reason: (typeof FAULT_REASONS)[number]; note: string | null };
      return charging.reportFault(actorOf(request).userId, request.params.bookingId, body, request.id);
    },
  );
  r.get(
    '/v1/host/bookings/:bookingId/charging',
    { preHandler: requireUser, schema: schema({ tags: ['host'] }) },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return charging.hostView(host.hostAccountId, request.params.bookingId);
    },
  );
};
