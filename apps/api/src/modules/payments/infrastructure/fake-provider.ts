import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  header,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderPayment,
  type ProviderRefund,
  type SettlementLine,
} from '../domain/provider.ts';

/**
 * In-process payment simulator for development and tests (refused in production, env.ts). It behaves like a provider
 * from the outside: orders, attempts, captures, refunds and settlements live in its own memory, and outcomes reach
 * the app only as HMAC-signed webhooks (or through the same API queries a real provider answers).
 */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-for-dev-and-tests-only';

export interface FakeProvider extends PaymentProvider {
  /** A customer completing (or failing) checkout at the provider. Returns the webhook the provider would send. */
  simulate(
    orderId: string,
    outcome: 'captured' | 'authorized' | 'failed',
    options?: { amountPaise?: number },
  ): { rawBody: string; headers: Record<string, string>; payment: ProviderPayment };
  /** Re-sign an arbitrary body (tests: tampering, unknown orders). */
  sign(rawBody: string, eventId?: string): Record<string, string>;
  settleRefund(
    refundId: string,
    outcome: 'processed' | 'failed',
  ): { rawBody: string; headers: Record<string, string> };
  orders: Map<string, { amountPaise: number; receipt: string; payments: ProviderPayment[] }>;
  refunds: Map<string, ProviderRefund & { receipt: string }>;
  /** Tests: make the next refund call fail (provider outage). */
  failNextRefund: boolean;
}

export function fakeProvider(): FakeProvider {
  const orders: FakeProvider['orders'] = new Map();
  const refunds: FakeProvider['refunds'] = new Map();
  const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;
  const sig = (body: string) => createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex');
  const sign = (rawBody: string, eventId = id('evt')) => ({
    'x-fake-signature': sig(rawBody),
    'x-fake-event-id': eventId,
    'content-type': 'application/json',
  });

  const findPayment = (paymentId: string) => {
    for (const o of orders.values()) {
      const p = o.payments.find((x) => x.paymentId === paymentId);
      if (p) return p;
    }
    return null;
  };

  const self: FakeProvider = {
    name: 'FAKE',
    orders,
    refunds,
    failNextRefund: false,
    async createOrder({ amountPaise, receipt }) {
      const orderId = id('order');
      orders.set(orderId, { amountPaise, receipt, payments: [] });
      return { orderId };
    },
    checkoutParams: ({ orderId, amountPaise }) => ({
      orderId,
      amount: amountPaise,
      currency: 'INR',
      simulator: 1,
    }),
    verifyWebhook(rawBody, headers) {
      const s = header(headers, 'x-fake-signature');
      if (!s) return false;
      const a = Buffer.from(sig(rawBody));
      const b = Buffer.from(s);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    parseWebhook(rawBody, headers): ProviderEvent {
      const body = JSON.parse(rawBody) as {
        event: string;
        payment?: ProviderPayment;
        refund?: ProviderRefund;
      };
      const eventId = header(headers, 'x-fake-event-id') ?? 'missing';
      if (body.refund) return { eventId, type: 'refund', refund: body.refund };
      if (body.payment) return { eventId, type: 'payment', payment: body.payment };
      return { eventId, type: 'ignored', name: body.event };
    },
    verifyCheckoutSignature: () => true,
    async fetchOrderPayments(orderId) {
      return [...(orders.get(orderId)?.payments ?? [])];
    },
    async capture(paymentId) {
      const p = findPayment(paymentId);
      if (!p) throw new Error('fake: unknown payment');
      p.status = 'captured';
      return { ...p };
    },
    async refund({ paymentId, amountPaise, receipt }) {
      if (self.failNextRefund) {
        self.failNextRefund = false;
        throw new Error('fake: provider unavailable');
      }
      const existing = [...refunds.values()].find((r) => r.receipt === receipt);
      if (existing) return existing;
      const r = { refundId: id('rfnd'), paymentId, amountPaise, status: 'pending' as const, receipt };
      refunds.set(r.refundId, r);
      return r;
    },
    async fetchRefund(_paymentId, refundId) {
      const r = refunds.get(refundId);
      if (!r) throw new Error('fake: unknown refund');
      return r;
    },
    async fetchSettlements() {
      const lines: SettlementLine[] = [];
      for (const o of orders.values()) {
        for (const p of o.payments.filter((x) => x.status === 'captured')) {
          const fee = Math.round(p.amountPaise * 0.02);
          lines.push({
            settlementId: 'setl_fake',
            entityKind: 'PAYMENT',
            entityId: p.paymentId,
            amountPaise: p.amountPaise,
            feePaise: fee,
            taxPaise: Math.round(fee * 0.18),
            settledAt: new Date(),
          });
        }
      }
      return lines;
    },
    simulate(orderId, outcome, options = {}) {
      const order = orders.get(orderId);
      if (!order) throw new Error('fake: unknown order');
      const payment: ProviderPayment = {
        paymentId: id('pay'),
        orderId,
        status: outcome,
        amountPaise: options.amountPaise ?? order.amountPaise,
        currency: 'INR',
        method: 'upi',
        errorCode: outcome === 'failed' ? 'BAD_REQUEST_ERROR' : null,
        errorDescription: outcome === 'failed' ? 'Payment was declined by the bank' : null,
      };
      order.payments.push(payment);
      const rawBody = JSON.stringify({ event: `payment.${outcome}`, payment });
      return { rawBody, headers: sign(rawBody), payment: { ...payment } };
    },
    sign,
    settleRefund(refundId, outcome) {
      const r = refunds.get(refundId);
      if (!r) throw new Error('fake: unknown refund');
      r.status = outcome;
      const rawBody = JSON.stringify({
        event: `refund.${outcome}`,
        refund: { refundId: r.refundId, paymentId: r.paymentId, amountPaise: r.amountPaise, status: outcome },
      });
      return { rawBody, headers: sign(rawBody) };
    },
  };
  return self;
}
