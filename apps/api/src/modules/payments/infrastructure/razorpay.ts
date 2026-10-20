import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  header,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderPayment,
  type ProviderRefund,
  type SettlementLine,
} from '../domain/provider.ts';

/**
 * Razorpay adapter (AR-2, D-120). REST v1 with basic auth; webhooks signed with HMAC-SHA256 over the raw body
 * (`X-Razorpay-Signature`), deduplicated by `X-Razorpay-Event-Id`. Orders are created per attempt; payments should
 * auto-capture (account setting), and `authorized` payments are captured by us as a fallback.
 * Secrets never leave this module and are never logged.
 */
export function razorpayProvider(config: {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): PaymentProvider {
  const base = (config.apiBase ?? 'https://api.razorpay.com').replace(/\/$/, '');
  const doFetch = config.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: string; description?: string };
    };
    if (!res.ok) {
      // Only the provider's error code and description: never request bodies or auth headers.
      throw new Error(
        `razorpay ${method} ${path.split('?')[0]} failed: ${res.status} ${data.error?.code ?? ''} ${data.error?.description ?? ''}`.trim(),
      );
    }
    return data;
  }

  const hmac = (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('hex');
  const equal = (a: string, b: string) => {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
  };

  type RzpPayment = {
    id: string;
    order_id: string;
    status: string;
    amount: number;
    currency: string;
    method?: string | null;
    error_code?: string | null;
    error_description?: string | null;
  };
  type RzpRefund = { id: string; payment_id: string; amount: number; status: string };
  const toPayment = (p: RzpPayment): ProviderPayment => ({
    paymentId: p.id,
    orderId: p.order_id,
    status: (['created', 'authorized', 'captured', 'failed', 'refunded'].includes(p.status)
      ? p.status
      : 'created') as ProviderPayment['status'],
    amountPaise: Number(p.amount),
    currency: p.currency,
    method: p.method ?? null,
    errorCode: p.error_code ?? null,
    errorDescription: p.error_description ?? null,
  });
  const toRefund = (r: RzpRefund): ProviderRefund => ({
    refundId: r.id,
    paymentId: r.payment_id,
    amountPaise: Number(r.amount),
    status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending',
  });

  return {
    name: 'RAZORPAY',
    async createOrder({ amountPaise, receipt, notes }) {
      const order = await call<{ id: string }>('POST', '/v1/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes,
      });
      return { orderId: order.id };
    },
    checkoutParams: ({ orderId, amountPaise }) => ({
      keyId: config.keyId,
      orderId,
      amount: amountPaise,
      currency: 'INR',
      name: 'ParkBro',
    }),
    verifyWebhook(rawBody, headers) {
      const signature = header(headers, 'x-razorpay-signature');
      return !!signature && equal(hmac(config.webhookSecret, rawBody), signature);
    },
    parseWebhook(rawBody, headers): ProviderEvent {
      const body = JSON.parse(rawBody) as {
        event: string;
        created_at?: number;
        payload?: { payment?: { entity: RzpPayment }; refund?: { entity: RzpRefund } };
      };
      // The event id header is Razorpay's dedupe key; fall back to a hash of the body for older deliveries.
      const eventId =
        header(headers, 'x-razorpay-event-id') ?? `body:${hmac('dedupe', rawBody).slice(0, 32)}`;
      if (body.event.startsWith('refund.') && body.payload?.refund)
        return { eventId, type: 'refund', refund: toRefund(body.payload.refund.entity) };
      if ((body.event.startsWith('payment.') || body.event === 'order.paid') && body.payload?.payment) {
        return { eventId, type: 'payment', payment: toPayment(body.payload.payment.entity) };
      }
      return { eventId, type: 'ignored', name: body.event };
    },
    verifyCheckoutSignature: ({ orderId, paymentId, signature }) =>
      equal(hmac(config.keySecret, `${orderId}|${paymentId}`), signature),
    async fetchOrderPayments(orderId) {
      const res = await call<{ items: RzpPayment[] }>(
        'GET',
        `/v1/orders/${encodeURIComponent(orderId)}/payments`,
      );
      return res.items.map(toPayment);
    },
    async capture(paymentId, amountPaise) {
      return toPayment(
        await call<RzpPayment>('POST', `/v1/payments/${encodeURIComponent(paymentId)}/capture`, {
          amount: amountPaise,
          currency: 'INR',
        }),
      );
    },
    async refund({ paymentId, amountPaise, receipt }) {
      // Idempotency by receipt: a retried submission finds the refund it already created.
      const existing = await call<{ items: (RzpRefund & { receipt?: string })[] }>(
        'GET',
        `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      );
      const found = existing.items.find((r) => r.receipt === receipt);
      if (found) return toRefund(found);
      return toRefund(
        await call<RzpRefund>('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
          amount: amountPaise,
          receipt,
          speed: 'normal',
        }),
      );
    },
    async fetchRefund(paymentId, refundId) {
      return toRefund(
        await call<RzpRefund>(
          'GET',
          `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
        ),
      );
    },
    async fetchSettlements(day) {
      const [year, month, d] = day.split('-');
      const res = await call<{
        items: {
          entity_id: string;
          type: string;
          amount: number;
          fee: number;
          tax: number;
          settlement_id: string;
          settled_at: number;
        }[];
      }>('GET', `/v1/settlements/recon/combined?year=${year}&month=${Number(month)}&day=${Number(d)}`);
      return res.items.map((i): SettlementLine => ({
        settlementId: i.settlement_id,
        entityKind: i.type === 'payment' ? 'PAYMENT' : i.type === 'refund' ? 'REFUND' : 'ADJUSTMENT',
        entityId: i.entity_id,
        amountPaise: Number(i.amount),
        feePaise: Number(i.fee ?? 0),
        taxPaise: Number(i.tax ?? 0),
        settledAt: new Date(Number(i.settled_at) * 1000),
      }));
    },
  };
}
