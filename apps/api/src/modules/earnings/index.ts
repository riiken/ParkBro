import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../platform/crypto/field-cipher.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { BookingModule } from '../booking/index.ts';
import type { HostService } from '../identity/index.ts';
import type { PaymentsModule } from '../payments/index.ts';
import { createEarningsService, type EarningsService } from './application/earnings-service.ts';
import { earningsAdminRoutes, earningsHostRoutes } from './http/routes.ts';
import type { EarningsDb } from './infrastructure/tables.ts';

export { captureSplit, refundSplit, RELEASE_AFTER_END_HOURS, MIN_PAYOUT_PAISE } from './domain/split.ts';

export interface EarningsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  releaseEarnings: EarningsService['releaseEarnings'];
  runPayouts: EarningsService['runPayouts'];
  backfill: EarningsService['backfill'];
  trialBalance: EarningsService['trialBalance'];
}

/** Host earnings, ledger and payouts (Phase 16). Posts from payment events; MANUAL payouts settled by finance. */
export function createEarningsModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  cipher: FieldCipher;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'earningsContext'>;
  payments: Pick<PaymentsModule, 'ledgerFeed'>;
  hosts: HostService;
  hasOpenDispute?: (bookingId: string) => Promise<boolean>;
  taxBps?: number;
  now?: () => number;
}): EarningsModule {
  const db = deps.db.withTables<EarningsDb>() as unknown as Kysely<EarningsDb>;
  const earnings = createEarningsService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(earningsHostRoutes, { earnings, hosts: deps.hosts });
      await api.register(earningsAdminRoutes, { prefix: '/admin', earnings });
    },
    releaseEarnings: earnings.releaseEarnings,
    runPayouts: earnings.runPayouts,
    backfill: earnings.backfill,
    trialBalance: earnings.trialBalance,
  };
}
