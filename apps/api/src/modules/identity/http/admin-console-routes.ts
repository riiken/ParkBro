import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { actorOf, requirePermission } from '../../../platform/auth/authentication.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import { pageOf, pageQuery } from '../../../platform/http/pagination.ts';
import type { AuthService } from '../application/auth-service.ts';
import { normalizeIndianMobile } from '../domain/phone.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';

const userRow = z.object({
  id: z.uuid(),
  displayName: z.string(),
  phoneMasked: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
  roles: z.array(z.string()),
  createdAt: z.date(),
});
const hostRow = z.object({
  id: z.uuid(),
  displayName: z.string(),
  kind: z.enum(['INDIVIDUAL', 'BUSINESS']),
  status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED']),
  ownerUserId: z.uuid().nullable(),
  createdAt: z.date(),
});
const reason = z.object({ reason: z.string().trim().min(5).max(300) });

/**
 * Admin console: users and host accounts (Phase 20, A-01). Search by exact phone (blind index) or name; never
 * returns full phone numbers. Status changes need a reason and are audited; suspension revokes sessions at once.
 */
export const identityAdminConsoleRoutes: FastifyPluginAsync<{
  db: Kysely<IdentityDb>;
  auth: AuthService;
  audit: AuditLog;
}> = async (app, { db, auth, audit }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = requirePermission('SUPPORT', 'TRUST_SAFETY');
  const write = requirePermission('TRUST_SAFETY');

  async function rolesOf(ids: string[]) {
    if (!ids.length) return new Map<string, string[]>();
    const rows = await db
      .selectFrom('identity.role_grants')
      .select(['user_id', 'role'])
      .where('user_id', 'in', ids)
      .execute();
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(row.user_id, [...(map.get(row.user_id) ?? []), row.role]);
    return map;
  }

  r.get(
    '/v1/users',
    {
      preHandler: read,
      schema: {
        tags: ['admin'],
        querystring: z.object({
          q: z.string().trim().max(60).optional(),
          status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
          ...pageQuery,
        }),
        response: { 200: pageOf(userRow) },
      },
    },
    async (request) => {
      const { q, status, offset, limit } = request.query;
      let query = db.selectFrom('identity.users');
      const phone = q ? normalizeIndianMobile(q) : null;
      if (phone) query = query.where('phone_hmac', '=', auth.phoneIndex(phone));
      else if (q) query = query.where('display_name', 'ilike', `%${q.replace(/[%_\\]/g, '\\$&')}%`);
      if (status) query = query.where('status', '=', status);
      const [rows, total] = await Promise.all([
        query
          .select(['id', 'display_name', 'phone_last4', 'status', 'created_at'])
          .orderBy('created_at', 'desc')
          .offset(offset)
          .limit(limit)
          .execute(),
        query.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
      ]);
      const roles = await rolesOf(rows.map((u) => u.id));
      return {
        items: rows.map((u) => ({
          id: u.id,
          displayName: u.display_name,
          phoneMasked: `+91 ••••••${u.phone_last4}`,
          status: u.status as 'ACTIVE',
          roles: roles.get(u.id) ?? [],
          createdAt: u.created_at,
        })),
        offset,
        limit,
        total: Number(total.n),
      };
    },
  );

  r.get(
    '/v1/users/:userId',
    { preHandler: read, schema: { tags: ['admin'], params: z.object({ userId: z.uuid() }) } },
    async (request) => {
      const u = await db
        .selectFrom('identity.users')
        .selectAll()
        .where('id', '=', request.params.userId)
        .executeTakeFirst();
      if (!u) throw errors.notFound();
      const [roles, hosts, sessions] = await Promise.all([
        rolesOf([u.id]),
        db
          .selectFrom('identity.host_members as m')
          .innerJoin('identity.host_accounts as a', 'a.id', 'm.host_account_id')
          .select(['a.id', 'a.display_name', 'a.status', 'm.role'])
          .where('m.user_id', '=', u.id)
          .execute(),
        db
          .selectFrom('identity.sessions')
          .select(sql<string>`count(*)`.as('n'))
          .where('user_id', '=', u.id)
          .where('revoked_at', 'is', null)
          .executeTakeFirstOrThrow(),
      ]);
      return {
        id: u.id,
        displayName: u.display_name,
        phoneMasked: `+91 ••••••${u.phone_last4}`,
        status: u.status,
        locale: u.locale,
        roles: roles.get(u.id) ?? [],
        hostAccounts: hosts.map((h) => ({
          id: h.id,
          displayName: h.display_name,
          status: h.status,
          role: h.role,
        })),
        activeSessions: Number(sessions.n),
        createdAt: u.created_at,
      };
    },
  );

  for (const [path, to] of [
    ['suspend', 'SUSPENDED'],
    ['reinstate', 'ACTIVE'],
  ] as const) {
    r.post(
      `/v1/users/:userId/${path}`,
      {
        preHandler: write,
        schema: { tags: ['admin'], params: z.object({ userId: z.uuid() }), body: reason },
      },
      async (request, reply) => {
        const admin = actorOf(request);
        if (request.params.userId === admin.userId) throw errors.forbidden();
        await db.transaction().execute(async (trx) => {
          const res = await trx
            .updateTable('identity.users')
            .set({ status: to })
            .where('id', '=', request.params.userId)
            .where('status', '<>', 'CLOSED')
            .executeTakeFirst();
          if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
          if (to === 'SUSPENDED')
            await trx
              .updateTable('identity.sessions')
              .set({ revoked_at: new Date(), revoked_reason: 'ACCOUNT_SUSPENDED' })
              .where('user_id', '=', request.params.userId)
              .where('revoked_at', 'is', null)
              .execute();
          await audit.record(
            {
              actorKind: 'ADMIN',
              actorId: admin.userId,
              action: `user.${path}`,
              entityKind: 'user',
              entityId: request.params.userId,
              metadata: { reason: request.body.reason },
              requestId: request.id,
            },
            trx,
          );
        });
        return reply.status(204).send();
      },
    );
  }

  r.get(
    '/v1/hosts',
    {
      preHandler: read,
      schema: {
        tags: ['admin'],
        querystring: z.object({
          q: z.string().trim().max(60).optional(),
          status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED']).optional(),
          ...pageQuery,
        }),
        response: { 200: pageOf(hostRow) },
      },
    },
    async (request) => {
      const { q, status, offset, limit } = request.query;
      let query = db.selectFrom('identity.host_accounts as a');
      if (q) query = query.where('a.display_name', 'ilike', `%${q.replace(/[%_\\]/g, '\\$&')}%`);
      if (status) query = query.where('a.status', '=', status);
      const [rows, total] = await Promise.all([
        query
          .select([
            'a.id',
            'a.display_name',
            'a.kind',
            'a.status',
            'a.created_at',
            sql<
              string | null
            >`(SELECT m.user_id FROM identity.host_members m WHERE m.host_account_id = a.id AND m.role = 'OWNER' LIMIT 1)`.as(
              'owner',
            ),
          ])
          .orderBy('a.created_at', 'desc')
          .offset(offset)
          .limit(limit)
          .execute(),
        query.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
      ]);
      return {
        items: rows.map((h) => ({
          id: h.id,
          displayName: h.display_name,
          kind: h.kind as 'INDIVIDUAL',
          status: h.status as 'ACTIVE',
          ownerUserId: h.owner,
          createdAt: h.created_at,
        })),
        offset,
        limit,
        total: Number(total.n),
      };
    },
  );

  r.post(
    '/v1/hosts/:hostAccountId/status',
    {
      preHandler: write,
      schema: {
        tags: ['admin'],
        params: z.object({ hostAccountId: z.uuid() }),
        body: reason.extend({ status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED']) }),
      },
    },
    async (request, reply) => {
      const admin = actorOf(request);
      // RESTRICTED/SUSPENDED hosts disappear from discovery (views) and can't change listings; existing bookings stand.
      const res = await db
        .updateTable('identity.host_accounts')
        .set({ status: request.body.status })
        .where('id', '=', request.params.hostAccountId)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
      await audit.record({
        actorKind: 'ADMIN',
        actorId: admin.userId,
        action: 'host.status_changed',
        entityKind: 'host_account',
        entityId: request.params.hostAccountId,
        metadata: { status: request.body.status, reason: request.body.reason },
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
};
