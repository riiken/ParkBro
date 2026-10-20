import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import { DIMENSIONS, type ReviewService } from '../application/review-service.ts';

const score = z.number().int().min(1).max(5);
const reviewView = z.object({
  rating: z.number(),
  dimensions: z.record(z.string(), z.number()),
  body: z.string().nullable(),
  status: z.enum(['SUBMITTED', 'PUBLISHED', 'REMOVED']),
  createdAt: z.date(),
});
const bookingReviews = z.object({
  canReview: z.boolean(),
  windowEndsAt: z.date(),
  mine: reviewView.nullable(),
  theirs: reviewView.nullable(),
});
const params = z.object({ bookingId: z.uuid() });

export const reviewRoutes: FastifyPluginAsync<{ reviews: ReviewService; hosts: HostService }> = async (
  app,
  { reviews, hosts },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/bookings/:bookingId/review',
    { preHandler: requireUser, schema: { tags: ['reviews'], params, response: { 200: bookingReviews } } },
    async (request) => reviews.forBooking(actorOf(request).userId, request.params.bookingId),
  );
  r.post(
    '/v1/bookings/:bookingId/review',
    {
      preHandler: requireUser,
      schema: {
        tags: ['reviews'],
        params,
        body: z.object({
          rating: score,
          dimensions: z.object(Object.fromEntries(DIMENSIONS.map((d) => [d, score.optional()]))).default({}),
          body: z.string().trim().max(1000).nullable().default(null),
        }),
        response: { 201: bookingReviews },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await reviews.submit(
            actorOf(request).userId,
            request.params.bookingId,
            request.body as never,
            request.id,
          ),
        ),
  );
  // Public: published reviews of a listing (customer names as "First L.").
  r.get(
    '/v1/listings/:listingId/reviews',
    {
      schema: {
        tags: ['reviews'],
        params: z.object({ listingId: z.uuid() }),
        response: {
          200: z.object({
            count: z.number().int(),
            average: z.number().nullable(),
            dimensions: z.record(z.string(), z.number()),
            items: z.array(
              z.object({
                rating: z.number(),
                body: z.string().nullable(),
                author: z.string(),
                month: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => reviews.listingReviews(request.params.listingId),
  );
  // Host: trust signals about a customer on one of their bookings (H-06).
  r.get(
    '/v1/host/bookings/:bookingId/customer-trust',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params,
        response: {
          200: z.object({
            phoneVerified: z.boolean(),
            completedBookings: z.number(),
            noShows: z.number(),
            hostRating: z.number().nullable(),
            hostRatingCount: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const host = await requireHostAccess(hosts, request, { forWrite: false });
      await reviews.forBooking(host.userId, request.params.bookingId); // 404 unless it is this host's booking
      return reviews.customerTrustForBooking(request.params.bookingId);
    },
  );
};

export const reviewAdminRoutes: FastifyPluginAsync<{ reviews: ReviewService }> = async (app, { reviews }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/reviews',
    {
      preHandler: requirePermission('TRUST_SAFETY', 'SUPPORT'),
      schema: {
        tags: ['admin'],
        querystring: z.object({
          status: z.enum(['SUBMITTED', 'PUBLISHED', 'REMOVED']).optional(),
          authorKind: z.enum(['CUSTOMER', 'HOST']).optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => reviews.adminList(request.query),
  );
  r.post(
    '/v1/reviews/:reviewId/remove',
    {
      preHandler: requirePermission('TRUST_SAFETY'),
      schema: {
        tags: ['admin'],
        params: z.object({ reviewId: z.uuid() }),
        body: z.object({ reason: z.string().trim().min(5).max(300) }),
      },
    },
    async (request, reply) => {
      await reviews.remove(actorOf(request).userId, request.params.reviewId, request.body.reason, request.id);
      return reply.status(204).send();
    },
  );
};
