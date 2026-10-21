import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requireUser } from '../../../platform/auth/authentication.ts';
import { DomainError } from '../../../platform/errors/domain-error.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import { BOOKING_MODES } from '../../pricing/index.ts';
import type { BookingService } from '../application/booking-service.ts';
import { ISSUE_KINDS } from '../application/issue-service.ts';
import { SERIES_STATUSES } from '../domain/series.ts';
import { BOOKING_STATUSES } from '../domain/state-machine.ts';

const bookingParams = z.object({ bookingId: z.uuid() });
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() }).default({});
const instant = z.coerce.date();

const idempotencyKey = (header: unknown): string => {
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(header)) {
    throw new DomainError({
      code: 'booking.idempotency_key_required',
      status: 400,
      title: 'Idempotency-Key header required',
      detail: 'Send a unique key (8–100 letters, digits, - or _) per booking attempt.',
    });
  }
  return header;
};

const priceLine = z.object({
  kind: z.enum(['BASE', 'SERVICE_FEE']),
  label: z.string(),
  quantity: z.number(),
  unitPricePaise: z.number(),
  amountPaise: z.number(),
});
const policyView = z.object({
  code: z.enum(['FLEXIBLE', 'MODERATE', 'STRICT']),
  version: z.string(),
  tiers: z.array(z.object({ minMinutesBeforeStart: z.number(), refundBps: z.number() })),
});

const issueView = z
  .object({
    id: z.uuid(),
    kind: z.enum(ISSUE_KINDS),
    status: z.enum(['OPEN', 'RESOLVED_ON_SITE', 'REFUNDED', 'ESCALATED', 'WITHDRAWN']),
    deadlineAt: z.date(),
    note: z.string().nullable(),
    createdAt: z.date(),
  })
  .nullable();

const customerBookingView = z.object({
  id: z.uuid(),
  status: z.enum(BOOKING_STATUSES),
  listing: z.object({ id: z.uuid(), title: z.string(), type: z.enum(['PARKING', 'EV_CHARGING']) }),
  mode: z.enum(BOOKING_MODES),
  start: z.date(),
  end: z.date(),
  vehicle: z.object({ plate: z.string(), vehicleClass: z.string() }).nullable(),
  price: z.object({ lines: z.array(priceLine), totalPaise: z.number() }),
  holdExpiresAt: z.date().nullable(),
  approvalExpiresAt: z.date().nullable(),
  cancellation: z.object({
    policy: policyView,
    cancellable: z.boolean(),
    refundIfCancelledNowPaise: z.number().nullable(),
    cancelledBy: z.enum(['CUSTOMER', 'HOST', 'PLATFORM']).nullable(),
    /** The host's or ParkBro's explanation (the host form promises the customer sees it). */
    reason: z.string().nullable(),
    refundPaise: z.number().nullable(),
  }),
  series: z.object({ id: z.uuid(), periodIndex: z.number().int() }).nullable(),
  issue: issueView,
  access: z
    .object({
      address: z.string().nullable(),
      unitLabel: z.string().nullable(),
      instructions: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.date(),
});

const hostBookingView = z.object({
  id: z.uuid(),
  status: z.enum(BOOKING_STATUSES),
  listing: z.object({ id: z.uuid(), title: z.string() }),
  unitLabel: z.string().nullable(),
  mode: z.enum(BOOKING_MODES),
  start: z.date(),
  end: z.date(),
  customer: z.object({ name: z.string() }),
  vehicle: z.object({ plate: z.string(), vehicleClass: z.string(), isEv: z.boolean() }).nullable(),
  totalPaise: z.number(),
  approvalExpiresAt: z.date().nullable(),
  cancelledBy: z.enum(['CUSTOMER', 'HOST', 'PLATFORM']).nullable(),
  series: z.object({ id: z.uuid(), periodIndex: z.number().int() }).nullable(),
  issue: issueView,
  canReportNoShow: z.boolean(),
  createdAt: z.date(),
});

const seriesParams = z.object({ seriesId: z.uuid() });
const seriesBase = {
  id: z.uuid(),
  status: z.enum(SERIES_STATUSES),
  endedReason: z.string().nullable(),
  cadence: z.enum(['MONTHLY']),
  listing: z.object({ id: z.uuid(), title: z.string() }),
  vehicle: z.object({ plate: z.string(), vehicleClass: z.string() }).nullable(),
  anchorStart: z.date(),
  periodPricePaise: z.number(),
  noticeDays: z.number().int(),
  graceDays: z.number().int(),
  noticeBy: z.enum(['CUSTOMER', 'HOST', 'PLATFORM']).nullable(),
  endsAt: z.date().nullable(),
  nextRenewal: z
    .object({ periodIndex: z.number().int(), start: z.date(), amountPaise: z.number() })
    .nullable(),
  periods: z.array(
    z.object({
      bookingId: z.uuid(),
      index: z.number().int(),
      status: z.enum(BOOKING_STATUSES),
      start: z.date(),
      end: z.date(),
      amountPaise: z.number(),
      payBy: z.date().nullable(),
    }),
  ),
  createdAt: z.date(),
};
const customerSeriesView = z.object(seriesBase);
const hostSeriesView = z.object({
  ...seriesBase,
  customer: z.object({ name: z.string() }),
  unitLabel: z.string().nullable(),
});

/** Booking API (api-design §5.6–5.8). Everything a customer or host sees here is scoped to their own bookings. */
export const bookingRoutes: FastifyPluginAsync<{ bookings: BookingService; hosts: HostService }> = async (
  app,
  { bookings, hosts },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/quotes',
    {
      preHandler: requireUser,
      schema: {
        tags: ['bookings'],
        body: z.object({ assetId: z.uuid(), mode: z.enum(BOOKING_MODES), start: instant, end: instant }),
        response: {
          201: z.object({
            quoteId: z.uuid(),
            assetId: z.uuid(),
            mode: z.enum(BOOKING_MODES),
            start: z.date(),
            end: z.date(),
            lines: z.array(priceLine),
            totalPaise: z.number(),
            expiresAt: z.date(),
            approvalRequired: z.boolean(),
            cancellationPolicy: policyView,
          }),
        },
      },
    },
    async (request, reply) => {
      const { assetId, mode, start, end } = request.body;
      const quote = await bookings.quote(actorOf(request).userId, {
        assetId,
        mode,
        start: start.getTime(),
        end: end.getTime(),
      });
      return reply.status(201).send(quote);
    },
  );

  r.post(
    '/v1/bookings',
    {
      preHandler: requireUser,
      schema: {
        tags: ['bookings'],
        body: z.object({ quoteId: z.uuid(), vehicleId: z.uuid() }),
        response: { 200: customerBookingView, 201: customerBookingView },
      },
    },
    async (request, reply) => {
      const customerId = actorOf(request).userId;
      const key = idempotencyKey(request.headers['idempotency-key']);
      const { bookingId, replayed } = await bookings.createBooking(
        customerId,
        { ...request.body, idempotencyKey: key },
        request.id,
      );
      const view = await bookings.customerBooking(customerId, bookingId);
      return reply.status(replayed ? 200 : 201).send(view);
    },
  );

  r.get(
    '/v1/bookings',
    {
      preHandler: requireUser,
      schema: { tags: ['bookings'], response: { 200: z.array(customerBookingView) } },
    },
    async (request) => bookings.customerBookings(actorOf(request).userId),
  );

  r.get(
    '/v1/bookings/:bookingId',
    {
      preHandler: requireUser,
      schema: { tags: ['bookings'], params: bookingParams, response: { 200: customerBookingView } },
    },
    async (request) => bookings.customerBooking(actorOf(request).userId, request.params.bookingId),
  );

  r.post(
    '/v1/bookings/:bookingId/cancel',
    {
      preHandler: requireUser,
      schema: {
        tags: ['bookings'],
        params: bookingParams,
        body: reasonBody,
        response: { 200: customerBookingView },
      },
    },
    async (request) => {
      const customerId = actorOf(request).userId;
      await bookings.cancelByCustomer(customerId, request.params.bookingId, request.body.reason, request.id);
      return bookings.customerBooking(customerId, request.params.bookingId);
    },
  );

  // ---------------------------------------------------------------- host

  r.get(
    '/v1/host/bookings',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: z.array(hostBookingView) } } },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return bookings.hostBookings(host.hostAccountId);
    },
  );

  r.get(
    '/v1/host/bookings/:bookingId',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: bookingParams, response: { 200: hostBookingView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );

  r.post(
    '/v1/host/bookings/:bookingId/approve',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: bookingParams, response: { 200: hostBookingView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: true });
      await bookings.approveByHost(host, request.params.bookingId, request.id);
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );

  r.post(
    '/v1/host/bookings/:bookingId/decline',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: bookingParams, body: reasonBody, response: { 200: hostBookingView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: true });
      await bookings.declineByHost(host, request.params.bookingId, request.body.reason, request.id);
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );

  r.post(
    '/v1/host/bookings/:bookingId/cancel',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: bookingParams,
        body: z.object({ reason: z.string().trim().min(5).max(300) }),
        response: { 200: hostBookingView },
      },
    },
    async (request) => {
      // Restricted hosts may still cancel (forWrite false): letting a customer know early beats a no-show host.
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      await bookings.cancelByHost(host, request.params.bookingId, request.body.reason, request.id);
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );

  // ---------------------------------------------------------------- monthly plans (booking series, D-104)

  r.get(
    '/v1/series',
    {
      preHandler: requireUser,
      schema: { tags: ['bookings'], response: { 200: z.array(customerSeriesView) } },
    },
    async (request) => bookings.series.listForCustomer(actorOf(request).userId),
  );

  r.get(
    '/v1/series/:seriesId',
    {
      preHandler: requireUser,
      schema: { tags: ['bookings'], params: seriesParams, response: { 200: customerSeriesView } },
    },
    async (request) => bookings.series.getForCustomer(actorOf(request).userId, request.params.seriesId),
  );

  r.post(
    '/v1/series/:seriesId/notice',
    {
      preHandler: requireUser,
      schema: { tags: ['bookings'], params: seriesParams, response: { 200: customerSeriesView } },
    },
    async (request) => {
      const customerId = actorOf(request).userId;
      await bookings.series.noticeByCustomer(customerId, request.params.seriesId, request.id);
      return bookings.series.getForCustomer(customerId, request.params.seriesId);
    },
  );

  r.get(
    '/v1/host/series',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: z.array(hostSeriesView) } } },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return bookings.series.listForHost(host.hostAccountId, host.userId);
    },
  );

  r.get(
    '/v1/host/series/:seriesId',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: seriesParams, response: { 200: hostSeriesView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      return bookings.series.getForHost(host.hostAccountId, host.userId, request.params.seriesId);
    },
  );

  r.post(
    '/v1/host/series/:seriesId/notice',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: seriesParams, response: { 200: hostSeriesView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      await bookings.series.noticeByHost(host, request.params.seriesId, request.id);
      return bookings.series.getForHost(host.hostAccountId, host.userId, request.params.seriesId);
    },
  );

  // ---------------------------------------------------------------- recourse and no-show (Phase 17)

  const issueParams = z.object({ bookingId: z.uuid(), issueId: z.uuid() });
  r.post(
    '/v1/bookings/:bookingId/issues',
    {
      preHandler: requireUser,
      schema: {
        tags: ['bookings'],
        params: bookingParams,
        body: z.object({
          kind: z.enum(ISSUE_KINDS),
          note: z.string().trim().max(500).nullable().default(null),
        }),
        response: { 201: customerBookingView },
      },
    },
    async (request, reply) => {
      const customerId = actorOf(request).userId;
      await bookings.issues.openByCustomer(
        customerId,
        request.params.bookingId,
        request.body.kind,
        request.body.note,
        request.id,
      );
      return reply.status(201).send(await bookings.customerBooking(customerId, request.params.bookingId));
    },
  );
  r.post(
    '/v1/bookings/:bookingId/issues/:issueId/:action',
    {
      preHandler: requireUser,
      schema: {
        tags: ['bookings'],
        params: issueParams.extend({ action: z.enum(['withdraw', 'escalate']) }),
        response: { 200: customerBookingView },
      },
    },
    async (request) => {
      const customerId = actorOf(request).userId;
      await bookings.issues.customerRespond(
        customerId,
        request.params.issueId,
        request.params.action === 'withdraw' ? 'WITHDRAWN' : 'ESCALATED',
        request.id,
      );
      return bookings.customerBooking(customerId, request.params.bookingId);
    },
  );
  r.post(
    '/v1/host/bookings/:bookingId/issues/:issueId/:action',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: issueParams.extend({ action: z.enum(['resolve', 'escalate']) }),
        body: z.object({ note: z.string().trim().max(500).nullable().default(null) }).default({ note: null }),
        response: { 200: hostBookingView },
      },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      await bookings.issues.hostRespond(
        host.hostAccountId,
        host.userId,
        request.params.issueId,
        request.params.action === 'resolve' ? 'RESOLVED_ON_SITE' : 'ESCALATED',
        request.body.note,
        request.id,
      );
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );
  r.post(
    '/v1/host/bookings/:bookingId/no-show',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: bookingParams, response: { 200: hostBookingView } },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: true });
      await bookings.reportNoShow(host, request.params.bookingId, request.id);
      return bookings.hostBooking(host.hostAccountId, request.params.bookingId);
    },
  );
};
