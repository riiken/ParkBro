import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditLog } from '../../platform/audit/audit-log.ts';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { RateLimiter } from '../../platform/rate-limit/rate-limiter.ts';
import type { BookingModule } from '../booking/index.ts';
import { createPaymentService, type PaymentService } from './application/payment-service.ts';
import type { PaymentProvider } from './domain/provider.ts';
import type { FakeProvider } from './infrastructure/fake-provider.ts';
import {
  fakeCheckoutRoutes,
  paymentAdminRoutes,
  paymentRoutes,
  paymentWebhookRoutes,
} from './http/routes.ts';
import type { PaymentsDb } from './infrastructure/tables.ts';

export { fakeProvider, FAKE_WEBHOOK_SECRET, type FakeProvider } from './infrastructure/fake-provider.ts';
export { razorpayProvider } from './infrastructure/razorpay.ts';
export type { PaymentProvider } from './domain/provider.ts';

export interface PaymentsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** Jobs. */
  submitRefunds: PaymentService['submitRefunds'];
  reconcile: PaymentService['reconcile'];
  importSettlements: PaymentService['importSettlements'];
  /** Tests and internal callers: the webhook entry point (same path as HTTP). */
  handleWebhook: PaymentService['handleWebhook'];
  /** Captured payments and refunds for the ledger's repair job. */
  ledgerFeed: PaymentService['ledgerFeed'];
  /** Disputes: evidence and refunds decided by admins. */
  adminBookingMoney: PaymentService['adminBookingMoney'];
  refundForDispute: PaymentService['refundForDispute'];
  riskSignals: PaymentService['riskSignals'];
}

/** Payments (Phase 15): orders, verified confirmation, refunds, reconciliation. Ledger arrives in Phase 16. */
export function createPaymentsModule<DB>(deps: {
  db: Kysely<DB>;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'paymentContext' | 'confirmPayment'>;
  provider: PaymentProvider;
  /** Present only with the fake provider outside production: enables the simulated checkout endpoint. */
  fakeCheckout?: FakeProvider;
  now?: () => number;
}): PaymentsModule {
  const db = deps.db.withTables<PaymentsDb>() as unknown as Kysely<PaymentsDb>;
  const payments = createPaymentService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(paymentRoutes, { payments });
      await api.register(paymentWebhookRoutes, { payments, provider: deps.provider.name });
      await api.register(paymentAdminRoutes, { prefix: '/admin', payments });
      if (deps.fakeCheckout) await api.register(fakeCheckoutRoutes, { payments, fake: deps.fakeCheckout });
    },
    submitRefunds: payments.submitRefunds,
    reconcile: payments.reconcile,
    importSettlements: payments.importSettlements,
    handleWebhook: payments.handleWebhook,
    ledgerFeed: payments.ledgerFeed,
    adminBookingMoney: payments.adminBookingMoney,
    refundForDispute: payments.refundForDispute,
    riskSignals: payments.riskSignals,
  };
}
