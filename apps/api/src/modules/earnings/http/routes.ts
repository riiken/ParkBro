import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import type { EarningsService } from '../application/earnings-service.ts';

const balances = z.object({
  pendingPaise: z.number(),
  availablePaise: z.number(),
  inPayoutPaise: z.number(),
  paidPaise: z.number(),
  receivablePaise: z.number(),
});
const payoutView = z.object({
  id: z.uuid(),
  hostAccountId: z.uuid(),
  amountPaise: z.number(),
  status: z.enum(['PROCESSING', 'PAID', 'FAILED']),
  reference: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.date(),
  settledAt: z.date().nullable(),
});
const accountView = z.object({
  id: z.uuid(),
  method: z.enum(['UPI', 'BANK']),
  holderName: z.string(),
  display: z.string(),
  status: z.enum(['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REPLACED']),
  holdUntil: z.date().nullable(),
  createdAt: z.date(),
});

/** Host earnings (H-09) and payouts (H-10). */
export const earningsHostRoutes: FastifyPluginAsync<{
  earnings: EarningsService;
  hosts: HostService;
}> = async (app, { earnings, hosts }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/host/earnings',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        response: {
          200: z.object({
            balances,
            releaseAfterHours: z.number(),
            minPayoutPaise: z.number(),
            bookings: z.array(
              z.object({
                bookingId: z.uuid(),
                customerPaidPaise: z.number(),
                refundedPaise: z.number(),
                grossPaise: z.number(),
                serviceFeePaise: z.number(),
                commissionPaise: z.number(),
                taxPaise: z.number(),
                netPaise: z.number(),
                status: z.enum(['PENDING', 'RELEASED', 'SETTLED']),
                firstAt: z.coerce.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      earnings.hostEarnings((await requireHostAccess(hosts, request, { forWrite: false })).hostAccountId),
  );

  r.get(
    '/v1/host/payouts',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: z.array(payoutView) } } },
    async (request) =>
      earnings.hostPayouts((await requireHostAccess(hosts, request, { forWrite: false })).hostAccountId),
  );

  r.get(
    '/v1/host/payout-account',
    { preHandler: requireUser, schema: { tags: ['host'], response: { 200: accountView.nullable() } } },
    async (request) =>
      earnings.payoutAccount((await requireHostAccess(hosts, request, { forWrite: false })).hostAccountId),
  );

  r.put(
    '/v1/host/payout-account',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        body: z.discriminatedUnion('method', [
          z.object({
            method: z.literal('UPI'),
            holderName: z.string().trim().min(2).max(100),
            vpa: z.string().trim().min(3).max(256),
          }),
          z.object({
            method: z.literal('BANK'),
            holderName: z.string().trim().min(2).max(100),
            accountNumber: z.string().trim().min(9).max(22),
            ifsc: z.string().trim().length(11),
          }),
        ]),
        response: { 200: accountView.nullable() },
      },
    },
    async (request) =>
      earnings.setPayoutAccount(
        await requireHostAccess(hosts, request, { forWrite: true }),
        request.body,
        request.id,
      ),
  );
};

/** Finance (A-05): payout accounts to verify, payouts to settle, the trial balance. */
export const earningsAdminRoutes: FastifyPluginAsync<{ earnings: EarningsService }> = async (
  app,
  { earnings },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('FINANCE');
  const id = z.object({ id: z.uuid() });

  r.get('/v1/payout-accounts/pending', { preHandler: guard, schema: { tags: ['admin'] } }, async () =>
    earnings.pendingPayoutAccounts(),
  );
  r.post(
    '/v1/payout-accounts/:id/review',
    {
      preHandler: guard,
      schema: { tags: ['admin'], params: id, body: z.object({ decision: z.enum(['VERIFIED', 'REJECTED']) }) },
    },
    async (request, reply) => {
      await earnings.reviewPayoutAccount(
        actorOf(request).userId,
        request.params.id,
        request.body.decision,
        request.id,
      );
      return reply.status(204).send();
    },
  );
  r.get(
    '/v1/payouts',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        querystring: z.object({
          status: z.enum(['PROCESSING', 'PAID', 'FAILED']).optional(),
          hostAccountId: z.uuid().optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => earnings.adminPayouts(request.query),
  );
  r.get(
    '/v1/payouts/open',
    { preHandler: guard, schema: { tags: ['admin'], response: { 200: z.array(payoutView) } } },
    async () => earnings.openPayouts(),
  );
  r.post(
    '/v1/payouts/:id/settle',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        params: id,
        body: z.discriminatedUnion('status', [
          z.object({ status: z.literal('PAID'), reference: z.string().trim().min(4).max(100) }),
          z.object({ status: z.literal('FAILED'), reason: z.string().trim().min(4).max(300) }),
        ]),
      },
    },
    async (request, reply) => {
      await earnings.settlePayout(actorOf(request).userId, request.params.id, request.body, request.id);
      return reply.status(204).send();
    },
  );
  r.get('/v1/ledger/trial-balance', { preHandler: guard, schema: { tags: ['admin'] } }, async () =>
    earnings.trialBalance(),
  );
};
