import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import { actorOf, requirePermission } from '../../platform/auth/authentication.ts';

type ClearanceDb = {
  'trust.verification_records': {
    subject_kind: string;
    subject_id: string;
    kind: string;
    status: string;
    note: string | null;
    actor_id: string;
    created_at: Date;
  };
};

/**
 * Pilot customer clearance (D-168): TRUST_SAFETY records that a customer's vehicle RC and ID were checked (offline
 * for now). With PILOT_CUSTOMER_CLEARANCE on, only cleared customers can book. Every decision needs a reason and is
 * audited; the history is append-only (latest wins).
 */
export const clearanceAdminRoutes: FastifyPluginAsync<{
  db: Kysely<ClearanceDb>;
  audit: AuditLog;
  record: (input: { userId: string; cleared: boolean; actorId: string; note: string }) => Promise<void>;
  required: boolean;
}> = async (app, { db, audit, record, required }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ userId: z.uuid() });

  r.get(
    '/v1/users/:userId/clearance',
    { preHandler: requirePermission('SUPPORT', 'TRUST_SAFETY'), schema: { tags: ['admin'], params } },
    async (request) => {
      const rows = await db
        .selectFrom('trust.verification_records')
        .select(['status', 'note', 'actor_id', 'created_at'])
        .where('subject_kind', '=', 'USER')
        .where('subject_id', '=', request.params.userId)
        .where('kind', '=', 'PILOT_CLEARANCE')
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      const latest = rows[0]?.status;
      return {
        required,
        status: latest === 'VERIFIED' ? 'CLEARED' : latest === 'REJECTED' ? 'REVOKED' : 'NONE',
        history: rows.map((h) => ({
          decision: h.status === 'VERIFIED' ? 'CLEARED' : 'REVOKED',
          reason: h.note,
          adminId: h.actor_id,
          at: h.created_at,
        })),
      };
    },
  );

  r.post(
    '/v1/users/:userId/clearance',
    {
      preHandler: requirePermission('TRUST_SAFETY'),
      schema: {
        tags: ['admin'],
        params,
        body: z.object({
          decision: z.enum(['CLEARED', 'REVOKED']),
          reason: z.string().trim().min(5).max(300),
        }),
      },
    },
    async (request, reply) => {
      const admin = actorOf(request).userId;
      const cleared = request.body.decision === 'CLEARED';
      await record({ userId: request.params.userId, cleared, actorId: admin, note: request.body.reason });
      await audit.record({
        actorKind: 'ADMIN',
        actorId: admin,
        action: cleared ? 'user.clearance_granted' : 'user.clearance_revoked',
        entityKind: 'user',
        entityId: request.params.userId,
        metadata: { reason: request.body.reason },
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
};
