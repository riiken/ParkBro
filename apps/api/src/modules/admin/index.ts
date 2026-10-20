import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AuditTables } from '../../platform/audit/audit-log.ts';
import { requirePermission } from '../../platform/auth/authentication.ts';
import type { Env } from '../../platform/config/env.ts';
import { pageQuery } from '../../platform/http/pagination.ts';
import type { AssetsModule } from '../assets/index.ts';
import {
  APPROVAL_HOURS,
  CANCELLATION_POLICIES,
  HOLD_MINUTES,
  ISSUE_RESPONSE_MINUTES,
  NO_SHOW_GRACE_MINUTES,
  type BookingModule,
} from '../booking/index.ts';
import { MIN_PAYOUT_PAISE, RELEASE_AFTER_END_HOURS } from '../earnings/index.ts';
import { PRICING_CONFIG } from '../pricing/index.ts';
import type { PaymentsModule } from '../payments/index.ts';

export interface AdminModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
}

type Signal = { kind: string; subject: { kind: string; id: string }; count: number; detail: string };

/**
 * Platform admin cross-cutting views (Phase 20): audit log, configuration (read-only), fraud indicators assembled
 * from each owning module's signals. Entity lists live with their modules (users, hosts, bookings, …).
 */
export function createAdminModule<DB>(deps: {
  db: Kysely<DB>;
  env: Env;
  booking: Pick<BookingModule, 'riskSignals'>;
  assets: Pick<AssetsModule, 'riskSignals'>;
  payments: Pick<PaymentsModule, 'riskSignals'>;
}): AdminModule {
  const db = deps.db.withTables<AuditTables>() as unknown as Kysely<AuditTables>;
  const routes: FastifyPluginAsync = async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/v1/audit',
      {
        preHandler: requirePermission('TRUST_SAFETY'),
        schema: {
          tags: ['admin'],
          querystring: z.object({
            entityKind: z.string().max(40).optional(),
            entityId: z.string().max(80).optional(),
            actorId: z.uuid().optional(),
            action: z.string().max(60).optional(),
            ...pageQuery,
          }),
        },
      },
      async (request) => {
        const f = request.query;
        let q = db.selectFrom('platform.audit_events');
        if (f.entityKind) q = q.where('entity_kind', '=', f.entityKind);
        if (f.entityId) q = q.where('entity_id', '=', f.entityId);
        if (f.actorId) q = q.where('actor_id', '=', f.actorId);
        if (f.action) q = q.where('action', 'like', `${f.action.replace(/[%_\\]/g, '\\$&')}%`);
        const [rows, total] = await Promise.all([
          q.selectAll().orderBy('id', 'desc').offset(f.offset).limit(f.limit).execute(),
          q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
        ]);
        return {
          items: rows.map((e) => ({
            id: e.id,
            actorKind: e.actor_kind,
            actorId: e.actor_id,
            action: e.action,
            entityKind: e.entity_kind,
            entityId: e.entity_id,
            metadata: e.metadata,
            requestId: e.request_id,
            at: e.created_at,
          })),
          offset: f.offset,
          limit: f.limit,
          total: Number(total.n),
        };
      },
    );

    // Configuration in force (read-only: changes go through code review and deployment for the pilot).
    r.get(
      '/v1/config',
      { preHandler: requirePermission('SUPPORT', 'TRUST_SAFETY', 'FINANCE'), schema: { tags: ['admin'] } },
      async () => ({
        pricing: PRICING_CONFIG,
        cancellationPolicies: CANCELLATION_POLICIES,
        booking: {
          holdMinutes: HOLD_MINUTES,
          approvalHours: APPROVAL_HOURS,
          noShowGraceMinutes: NO_SHOW_GRACE_MINUTES,
          issueResponseMinutes: ISSUE_RESPONSE_MINUTES,
        },
        earnings: { releaseAfterHours: RELEASE_AFTER_END_HOURS, minPayoutPaise: MIN_PAYOUT_PAISE },
        providers: {
          payments: deps.env.PAYMENT_PROVIDER,
          messaging: deps.env.MESSAGING_PROVIDER,
          otp: deps.env.OTP_PROVIDER,
          geocoder: deps.env.GEOCODER_PROVIDER,
        },
        jobsEnabled: deps.env.JOBS_ENABLED,
      }),
    );

    // Fraud indicators (A-04): signals for humans to look at, never automatic actions.
    r.get(
      '/v1/fraud-indicators',
      { preHandler: requirePermission('TRUST_SAFETY'), schema: { tags: ['admin'] } },
      async () => {
        const signals: Signal[] = (
          await Promise.all([
            deps.booking.riskSignals(),
            deps.assets.riskSignals(),
            deps.payments.riskSignals(),
          ])
        ).flat();
        return signals.sort((a, b) => b.count - a.count);
      },
    );
  };
  return { registerRoutes: async (api) => api.register(routes, { prefix: '/admin' }) };
}
