import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import type { PaymentService } from '../application/payment-service.ts';
import { paymentErrors } from '../application/payment-service.ts';
import { PAYMENT_STATUSES, REFUND_STATUSES } from '../domain/payment.ts';
import type { FakeProvider } from '../infrastructure/fake-provider.ts';

const paymentView = z.object({
  id: z.uuid(),
  bookingId: z.uuid(),
  status: z.enum(PAYMENT_STATUSES),
  provider: z.enum(['FAKE', 'RAZORPAY']),
  amountPaise: z.number(),
  currency: z.literal('INR'),
  method: z.string().nullable(),
  failureReason: z.string().nullable(),
  checkout: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
  createdAt: z.date(),
  succeededAt: z.date().nullable(),
});

const idempotencyKey = (header: unknown): string => {
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(header))
    throw paymentErrors.idempotencyRequired();
  return header;
};

/** Customer payment API (api-design §5.9). Payment success is never accepted from the browser. */
export const paymentRoutes: FastifyPluginAsync<{ payments: PaymentService }> = async (app, { payments }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/bookings/:bookingId/payments',
    {
      preHandler: requireUser,
      schema: {
        tags: ['payments'],
        params: z.object({ bookingId: z.uuid() }),
        response: { 201: paymentView },
      },
    },
    async (request, reply) => {
      const key = idempotencyKey(request.headers['idempotency-key']);
      return reply
        .status(201)
        .send(
          await payments.createPayment(actorOf(request).userId, request.params.bookingId, key, request.id),
        );
    },
  );

  r.get(
    '/v1/bookings/:bookingId/payments',
    {
      preHandler: requireUser,
      schema: {
        tags: ['payments'],
        params: z.object({ bookingId: z.uuid() }),
        response: {
          200: z.object({
            payments: z.array(paymentView),
            refunds: z.array(
              z.object({
                id: z.uuid(),
                amountPaise: z.number(),
                reason: z.string(),
                status: z.enum(REFUND_STATUSES),
                createdAt: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => payments.bookingPayments(actorOf(request).userId, request.params.bookingId),
  );

  r.get(
    '/v1/payments/:paymentId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['payments'],
        params: z.object({ paymentId: z.uuid() }),
        response: { 200: paymentView },
      },
    },
    async (request) => payments.getPayment(actorOf(request).userId, request.params.paymentId),
  );

  r.post(
    '/v1/payments/:paymentId/return',
    {
      preHandler: requireUser,
      schema: {
        tags: ['payments'],
        params: z.object({ paymentId: z.uuid() }),
        // Razorpay checkout handler fields; treated as hints only.
        body: z
          .object({
            providerPaymentId: z.string().max(100).optional(),
            signature: z.string().max(200).optional(),
          })
          .default({}),
        response: { 200: paymentView },
      },
    },
    async (request) =>
      payments.clientReturned(actorOf(request).userId, request.params.paymentId, request.body, request.id),
  );
};

/**
 * Provider webhooks: raw body (the signature covers the exact bytes), no session, no CSRF header (authenticated by
 * the HMAC signature instead). Unsigned or tampered requests are rejected and not stored.
 */
export const paymentWebhookRoutes: FastifyPluginAsync<{
  payments: PaymentService;
  provider: string;
}> = async (app, { payments, provider }) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post(
    `/v1/webhooks/payments/${provider.toLowerCase()}`,
    { config: { csrf: false } },
    async (request, reply) => {
      if (typeof request.body !== 'string') throw errors.notFound();
      const result = await payments.handleWebhook(request.body, request.headers, request.id);
      return reply.status(200).send({ status: result.status });
    },
  );
};

/** Development/test only (never registered with a real provider): play the provider's checkout for one order. */
export const fakeCheckoutRoutes: FastifyPluginAsync<{
  payments: PaymentService;
  fake: FakeProvider;
}> = async (app, { payments, fake }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    '/v1/dev/fake-checkout/:paymentId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['dev'],
        params: z.object({ paymentId: z.uuid() }),
        body: z.object({ outcome: z.enum(['captured', 'failed']) }),
      },
    },
    async (request) => {
      const payment = await payments.getPayment(actorOf(request).userId, request.params.paymentId);
      const orderId = String(payment.checkout?.orderId ?? '');
      if (!orderId) throw errors.notFound();
      const hook = fake.simulate(orderId, request.body.outcome);
      // Delivered through the same verification and processing path as a real provider webhook.
      await payments.handleWebhook(hook.rawBody, hook.headers, request.id);
      return { ok: true };
    },
  );
};

export const paymentAdminRoutes: FastifyPluginAsync<{ payments: PaymentService }> = async (
  app,
  { payments },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('FINANCE');
  r.get(
    '/v1/payments',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        querystring: z.object({
          status: z.enum(PAYMENT_STATUSES).optional(),
          bookingId: z.uuid().optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => payments.adminPayments(request.query),
  );
  r.get(
    '/v1/refunds',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        querystring: z.object({ status: z.enum(REFUND_STATUSES).optional(), ...pageQuery }),
      },
    },
    async (request) => payments.adminRefunds(request.query),
  );
  r.get(
    '/v1/payments/reconciliation',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              kind: z.string(),
              refs: z.record(z.string(), z.unknown()),
              createdAt: z.date(),
            }),
          ),
        },
      },
    },
    async () => payments.openReconciliation(),
  );
  r.post(
    '/v1/payments/reconciliation/:itemId/resolve',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: z.object({ itemId: z.uuid() }),
        body: z.object({ note: z.string().trim().min(5).max(500) }),
      },
    },
    async (request, reply) => {
      await payments.resolveReconciliation(
        actorOf(request).userId,
        request.params.itemId,
        request.body.note,
        request.id,
      );
      return reply.status(204).send();
    },
  );
};
