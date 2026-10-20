import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nextPaymentStatus } from '../../src/modules/payments/domain/payment.ts';
import { razorpayProvider } from '../../src/modules/payments/infrastructure/razorpay.ts';

const KEY_SECRET = 'test_key_secret_0123456789';
const WEBHOOK_SECRET = 'test_webhook_secret_0123456789';

function stub(responses: Record<string, unknown>) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? 'GET',
      url,
      auth: headers.get('authorization'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const key = `${init.method} ${new URL(url).pathname}`;
    const res = responses[key];
    if (res === undefined)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', description: 'no stub' } }), {
        status: 404,
      });
    return new Response(JSON.stringify(res), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const provider = (fetchImpl?: typeof fetch) =>
  razorpayProvider({
    keyId: 'rzp_test_ABC',
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    apiBase: 'https://rzp.example',
    ...(fetchImpl ? { fetchImpl } : {}),
  });

describe('razorpay adapter', () => {
  it('creates orders in paise with basic auth and exposes only public checkout values', async () => {
    const s = stub({ 'POST /v1/orders': { id: 'order_123', amount: 8000, status: 'created' } });
    const p = provider(s.fetchImpl);
    expect(await p.createOrder({ amountPaise: 8000, receipt: 'pay-1', notes: { bookingId: 'b1' } })).toEqual({
      orderId: 'order_123',
    });
    expect(s.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://rzp.example/v1/orders',
      auth: `Basic ${Buffer.from(`rzp_test_ABC:${KEY_SECRET}`).toString('base64')}`,
      body: { amount: 8000, currency: 'INR', receipt: 'pay-1', notes: { bookingId: 'b1' } },
    });
    const params = p.checkoutParams({ orderId: 'order_123', amountPaise: 8000 });
    expect(params).toEqual({
      keyId: 'rzp_test_ABC',
      orderId: 'order_123',
      amount: 8000,
      currency: 'INR',
      name: 'ParkBro',
    });
    expect(JSON.stringify(params)).not.toContain(KEY_SECRET);
  });

  it('verifies webhook signatures over the exact raw body (constant-time) and parses events', () => {
    const p = provider();
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_1',
            order_id: 'order_1',
            status: 'captured',
            amount: 8000,
            currency: 'INR',
            method: 'upi',
          },
        },
      },
    });
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    const headers = { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' };
    expect(p.verifyWebhook(body, headers)).toBe(true);
    expect(p.verifyWebhook(`${body} `, headers)).toBe(false);
    expect(p.verifyWebhook(body, { 'x-razorpay-signature': sig.slice(0, -1) })).toBe(false);
    expect(p.verifyWebhook(body, {})).toBe(false);
    expect(p.parseWebhook(body, headers)).toEqual({
      eventId: 'evt_1',
      type: 'payment',
      payment: {
        paymentId: 'pay_1',
        orderId: 'order_1',
        status: 'captured',
        amountPaise: 8000,
        currency: 'INR',
        method: 'upi',
        errorCode: null,
        errorDescription: null,
      },
    });
    const refund = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 4000, status: 'processed' } },
      },
    });
    expect(p.parseWebhook(refund, { 'x-razorpay-event-id': 'evt_2' })).toEqual({
      eventId: 'evt_2',
      type: 'refund',
      refund: { refundId: 'rfnd_1', paymentId: 'pay_1', amountPaise: 4000, status: 'processed' },
    });
    expect(
      p.parseWebhook(JSON.stringify({ event: 'settlement.processed' }), { 'x-razorpay-event-id': 'e3' }),
    ).toEqual({ eventId: 'e3', type: 'ignored', name: 'settlement.processed' });
  });

  it('verifies the checkout handler signature (order|payment) with the key secret', () => {
    const p = provider();
    const signature = createHmac('sha256', KEY_SECRET).update('order_1|pay_1').digest('hex');
    expect(p.verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature })).toBe(true);
    expect(p.verifyCheckoutSignature({ orderId: 'order_2', paymentId: 'pay_1', signature })).toBe(false);
  });

  it('refunds are idempotent by receipt', async () => {
    const s = stub({
      'GET /v1/payments/pay_1/refunds': {
        items: [
          { id: 'rfnd_9', payment_id: 'pay_1', amount: 4000, status: 'processed', receipt: 'refund-a' },
        ],
      },
      'POST /v1/payments/pay_1/refund': {
        id: 'rfnd_10',
        payment_id: 'pay_1',
        amount: 1000,
        status: 'pending',
      },
    });
    const p = provider(s.fetchImpl);
    expect(await p.refund({ paymentId: 'pay_1', amountPaise: 4000, receipt: 'refund-a' })).toMatchObject({
      refundId: 'rfnd_9',
      status: 'processed',
    });
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(await p.refund({ paymentId: 'pay_1', amountPaise: 1000, receipt: 'refund-b' })).toMatchObject({
      refundId: 'rfnd_10',
      status: 'pending',
    });
    expect(s.calls.at(-1)?.body).toEqual({ amount: 1000, receipt: 'refund-b', speed: 'normal' });
  });

  it('provider errors carry the code but never credentials', async () => {
    const s = stub({});
    const p = provider(s.fetchImpl);
    const error = await p.fetchOrderPayments('order_x').catch((e: Error) => e);
    expect(String(error)).toMatch(/404 NOT_FOUND/);
    expect(String(error)).not.toContain(KEY_SECRET);
  });
});

describe('payment state machine (§5.5)', () => {
  it('success is final; failures and expiry can be overtaken by a later capture', () => {
    expect(nextPaymentStatus('CREATED', 'CLIENT_RETURNED')).toBe('PENDING');
    expect(nextPaymentStatus('PENDING', 'CAPTURED')).toBe('SUCCEEDED');
    expect(nextPaymentStatus('FAILED', 'CAPTURED')).toBe('SUCCEEDED');
    expect(nextPaymentStatus('EXPIRED', 'CAPTURED')).toBe('SUCCEEDED');
    expect(nextPaymentStatus('SUCCEEDED', 'FAILED')).toBeNull();
    expect(nextPaymentStatus('SUCCEEDED', 'EXPIRED')).toBeNull();
    expect(nextPaymentStatus('SUCCEEDED', 'CLIENT_RETURNED')).toBeNull();
    expect(nextPaymentStatus('FAILED', 'CLIENT_RETURNED')).toBeNull();
  });
});
