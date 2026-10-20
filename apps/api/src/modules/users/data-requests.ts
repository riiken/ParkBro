import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type ColumnType, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import { actorOf, requirePermission, requireUser } from '../../platform/auth/authentication.ts';
import { errors } from '../../platform/errors/domain-error.ts';
import { pageQuery } from '../../platform/http/pagination.ts';
import { uuidv7 } from '../../platform/ids/uuid.ts';

/** Working default response time; confirm against the DPDP Rules with counsel (trust-and-safety §14). */
export const DATA_REQUEST_DUE_DAYS = 30;
const KINDS = ['ACCESS', 'CORRECTION', 'ERASURE'] as const;

interface DataRequestsTable {
  id: string;
  user_id: string;
  kind: string;
  details: string | null;
  status: ColumnType<string, string | undefined, string>;
  due_at: Date;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}
type Db = { 'users.data_requests': DataRequestsTable };

const view = (r: {
  id: string;
  kind: string;
  details: string | null;
  status: string;
  due_at: Date;
  resolution: string | null;
  resolved_at: Date | null;
  created_at: Date;
}) => ({
  id: r.id,
  kind: r.kind,
  details: r.details,
  status: r.status,
  dueAt: r.due_at,
  resolution: r.resolution,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
});

/**
 * Data-rights requests (DPDP; D-169): the customer side (request, see status) and the trust & safety queue
 * (fulfil or reject with a recorded resolution). Every step is audited.
 */
export const dataRequestRoutes: FastifyPluginAsync<{
  db: Kysely<Db>;
  audit: AuditLog;
  now: () => number;
}> = async (app, { db, audit, now }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me/data-requests', { preHandler: requireUser, schema: { tags: ['me'] } }, async (request) =>
    (
      await db
        .selectFrom('users.data_requests')
        .selectAll()
        .where('user_id', '=', actorOf(request).userId)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute()
    ).map(view),
  );

  r.post(
    '/v1/me/data-requests',
    {
      preHandler: requireUser,
      schema: {
        tags: ['me'],
        body: z.object({ kind: z.enum(KINDS), details: z.string().trim().max(500).optional() }),
      },
    },
    async (request, reply) => {
      const userId = actorOf(request).userId;
      const open = await db
        .selectFrom('users.data_requests')
        .selectAll()
        .where('user_id', '=', userId)
        .where('kind', '=', request.body.kind)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();
      if (open) return reply.status(200).send(view(open));
      const id = uuidv7();
      const created = await db
        .insertInto('users.data_requests')
        .values({
          id,
          user_id: userId,
          kind: request.body.kind,
          details: request.body.details || null,
          due_at: new Date(now() + DATA_REQUEST_DUE_DAYS * 86_400_000),
        })
        .onConflict((oc) => oc.doNothing()) // a parallel duplicate tap
        .returningAll()
        .executeTakeFirst();
      await audit.record({
        actorKind: 'USER',
        actorId: userId,
        action: `data_request.${request.body.kind.toLowerCase()}_requested`,
        entityKind: 'user',
        entityId: userId,
        metadata: { requestId: id },
        requestId: request.id,
      });
      const row =
        created ??
        (await db
          .selectFrom('users.data_requests')
          .selectAll()
          .where('user_id', '=', userId)
          .where('kind', '=', request.body.kind)
          .where('status', '=', 'OPEN')
          .executeTakeFirstOrThrow());
      return reply.status(201).send(view(row));
    },
  );
};

export const dataRequestAdminRoutes: FastifyPluginAsync<{
  db: Kysely<Db>;
  audit: AuditLog;
  now: () => number;
}> = async (app, { db, audit, now }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/v1/data-requests',
    {
      preHandler: requirePermission('TRUST_SAFETY'),
      schema: {
        tags: ['admin'],
        querystring: z.object({ status: z.enum(['OPEN', 'COMPLETED', 'REJECTED']).optional(), ...pageQuery }),
      },
    },
    async (request) => {
      const f = request.query;
      let q = db.selectFrom('users.data_requests');
      if (f.status) q = q.where('status', '=', f.status);
      const [rows, total] = await Promise.all([
        q.selectAll().orderBy('due_at').offset(f.offset).limit(f.limit).execute(),
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
      ]);
      return {
        items: rows.map((x) => ({ ...view(x), userId: x.user_id })),
        offset: f.offset,
        limit: f.limit,
        total: Number(total.n),
      };
    },
  );
  r.post(
    '/v1/data-requests/:id/resolve',
    {
      preHandler: requirePermission('TRUST_SAFETY'),
      schema: {
        tags: ['admin'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          status: z.enum(['COMPLETED', 'REJECTED']),
          resolution: z.string().trim().min(5).max(500),
        }),
      },
    },
    async (request, reply) => {
      const admin = actorOf(request).userId;
      const res = await db
        .updateTable('users.data_requests')
        .set({
          status: request.body.status,
          resolution: request.body.resolution,
          resolved_by: admin,
          resolved_at: new Date(now()),
        })
        .where('id', '=', request.params.id)
        .where('status', '=', 'OPEN')
        .returning(['user_id', 'kind'])
        .executeTakeFirst();
      if (!res) throw errors.notFound();
      await audit.record({
        actorKind: 'ADMIN',
        actorId: admin,
        action: `data_request.${request.body.status.toLowerCase()}`,
        entityKind: 'user',
        entityId: res.user_id,
        metadata: { requestId: request.params.id, kind: res.kind, resolution: request.body.resolution },
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
};
