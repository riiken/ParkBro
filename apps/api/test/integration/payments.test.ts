import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let kit: ReturnType<typeof bookingKit>;
const fake = fakeProvider();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: fake });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const day = istDay(4);
type Customer = Awaited<ReturnType<typeof kit.customer>>;

async function holdFor(seed: number, extra: Parameters<typeof kit.listing>[1] = {}) {
  const l = await kit.listing(seed, { units: ['P1'], ...extra });
  const c = await kit.customer();
  const b = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '12:00'));
  return { l, c, b };
}

const pay = (c: Customer, bookingId: string, key: string = randomUUID()) =>
  h.app.inject({
    method: 'POST',
    url: `/api/v1/bookings/${bookingId}/payments`,
    headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': key },
  });

/** Delivers a webhook over HTTP exactly as the provider would (no session, no CSRF header). */
const webhook = (hook: { rawBody: string; headers: Record<string, string> }) =>
  h.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/payments/fake',
    headers: hook.headers,
    payload: hook.rawBody,
  });

const bookingStatus = async (c: Customer, id: string) =>
  (await h.get(`/api/v1/bookings/${id}`, c.cookie)).json().status;
const paymentRow = async (id: string) =>
  (await kit.sql(`SELECT * FROM payments.payments WHERE id = $1`, [id])).rows[0];

describe('successful payment', () => {
  it('confirms the booking only from the signed provider webhook', async () => {
    const { c, b } = await holdFor(1);
    const created = await pay(c, b.id);
    expect(created.statusCode, created.body).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({
      status: 'CREATED',
      provider: 'FAKE',
      amountPaise: 8000,
      checkout: { amount: 8000 },
    });
    // Same key → same payment; a new key while it is open → same open attempt (no second order).

    const again = await pay(c, b.id);
    expect(again.json().id).toBe(p.id);
    expect(fake.orders.size).toBeGreaterThan(0);

    // The browser claims success: nothing changes until the provider says so.
    const claimed = await h.post(
      `/api/v1/payments/${p.id}/return`,
      { providerPaymentId: 'pay_forged', signature: 'x' },
      { cookie: c.cookie },
    );
    expect(claimed.json().status).toBe('PENDING');
    expect(await bookingStatus(c, b.id)).toBe('PENDING_PAYMENT');

    const hook = fake.simulate(p.checkout.orderId, 'captured');
    const res = await webhook(hook);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'processed' });
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
    expect(await paymentRow(p.id)).toMatchObject({
      status: 'SUCCEEDED',
      provider_payment_id: hook.payment.paymentId,
      method: 'upi',
    });
    const listed = (await h.get(`/api/v1/bookings/${b.id}/payments`, c.cookie)).json();
    expect(listed.payments.filter((x: { status: string }) => x.status === 'SUCCEEDED')).toHaveLength(1);
    // A confirmed booking can't be paid again.
    expect((await pay(c, b.id)).json().code).toBe('payment.booking_not_payable');
  });

  it('a return from checkout triggers a server-side query that can confirm without a webhook', async () => {
    const { c, b } = await holdFor(2);
    const p = (await pay(c, b.id)).json();
    fake.simulate(p.checkout.orderId, 'captured'); // provider has it; the webhook is "lost"
    const res = await h.post(`/api/v1/payments/${p.id}/return`, {}, { cookie: c.cookie });
    expect(res.json().status).toBe('SUCCEEDED');
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
    const events = await kit.sql(
      `SELECT source, to_status FROM payments.payment_events WHERE payment_id = $1 ORDER BY id`,
      [p.id],
    );
    expect(events.rows.map((r) => `${r.source}:${r.to_status}`)).toEqual([
      'CUSTOMER:CREATED',
      'CUSTOMER:PENDING',
      'PROVIDER_QUERY:SUCCEEDED',
    ]);
  });

  it('an authorized payment is captured by us for the ordered amount', async () => {
    const { c, b } = await holdFor(3);
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'authorized'));
    expect((await paymentRow(p.id)).status).toBe('SUCCEEDED');
    expect(fake.orders.get(p.checkout.orderId)?.payments[0]?.status).toBe('captured');
  });
});

describe('failed payment', () => {
  it('records the failure; the booking stays held and a retry on the same order can still succeed', async () => {
    const { c, b } = await holdFor(4);
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'failed'));
    const failed = (await h.get(`/api/v1/payments/${p.id}`, c.cookie)).json();
    expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'Payment was declined by the bank' });
    expect(await bookingStatus(c, b.id)).toBe('PENDING_PAYMENT');
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    expect((await paymentRow(p.id)).status).toBe('SUCCEEDED');
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
  });
});

describe('webhook integrity', () => {
  it('duplicate deliveries are processed once', async () => {
    const { c, b } = await holdFor(5);
    const p = (await pay(c, b.id)).json();
    const hook = fake.simulate(p.checkout.orderId, 'captured');
    const [x, y] = await Promise.all([webhook(hook), webhook(hook)]);
    expect([x.json().status, y.json().status].sort()).toEqual(['duplicate', 'processed']);
    expect((await webhook(hook)).json().status).toBe('duplicate');
    const events = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.payment_events WHERE payment_id = $1 AND to_status = 'SUCCEEDED'`,
      [p.id],
    );
    expect(events.rows[0].n).toBe(1);
    const stored = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.provider_events WHERE event_id = $1`,
      [hook.headers['x-fake-event-id']],
    );
    expect(stored.rows[0].n).toBe(1);
  });

  it('unsigned or tampered webhooks are rejected and not stored', async () => {
    const { c, b } = await holdFor(6);
    const p = (await pay(c, b.id)).json();
    const hook = fake.simulate(p.checkout.orderId, 'captured');
    const tampered = hook.rawBody.replace('"captured"', '"captured" ');
    const bad = await webhook({ rawBody: tampered, headers: hook.headers });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('payment.invalid_signature');
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payments/fake',
      headers: { 'content-type': 'application/json' },
      payload: hook.rawBody,
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await paymentRow(p.id)).status).toBe('CREATED');
    const stored = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.provider_events WHERE event_id = $1`,
      [hook.headers['x-fake-event-id']],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it('an amount mismatch is quarantined and never confirms', async () => {
    const { c, b } = await holdFor(7);
    const p = (await pay(c, b.id)).json();
    const res = await webhook(fake.simulate(p.checkout.orderId, 'captured', { amountPaise: 100 }));
    expect(res.json().status).toBe('quarantined');
    expect(await paymentRow(p.id)).toMatchObject({ status: 'CREATED', mismatch: true });
    expect(await bookingStatus(c, b.id)).toBe('PENDING_PAYMENT');
    const items = await kit.sql(
      `SELECT kind, refs FROM payments.reconciliation_items WHERE dedupe_key = $1`,
      [`mismatch:${p.id}`],
    );
    expect(items.rows[0]).toMatchObject({ kind: 'AMOUNT_MISMATCH', refs: { expected: 8000, received: 100 } });
    // Even a correct capture afterwards does not confirm a quarantined payment (finance resolves it).
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    expect(await bookingStatus(c, b.id)).toBe('PENDING_PAYMENT');
  });

  it('a payment for an unknown order is quarantined for finance', async () => {
    const order = await fake.createOrder({ amountPaise: 500, receipt: 'not-ours', notes: {} });
    const res = await webhook(fake.simulate(order.orderId, 'captured'));
    expect(res.json().status).toBe('quarantined');
    const items = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.reconciliation_items WHERE kind = 'UNKNOWN_PAYMENT'`,
    );
    expect(items.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('delayed webhook (BR-15)', () => {
  it('revives a lapsed hold if the space is still free', async () => {
    const { c, b } = await holdFor(8);
    const p = (await pay(c, b.id)).json();
    await kit.sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    await h.modules.booking.expireLapsedHolds();
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
  });

  it('refunds in full when the space was taken meanwhile', async () => {
    const { l, c, b } = await holdFor(9);
    const p = (await pay(c, b.id)).json();
    await kit.sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    const other = await kit.customer();
    await kit.booked(other, l.assetId, at(day, '10:00'), at(day, '12:00'));
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    expect(await bookingStatus(c, b.id)).toBe('EXPIRED');
    const refund = await kit.sql(
      `SELECT reason, amount_paise::int AS amount, status FROM payments.refunds WHERE payment_id = $1`,
      [p.id],
    );
    expect(refund.rows).toEqual([{ reason: 'LATE_PAYMENT_UNAVAILABLE', amount: 8000, status: 'PENDING' }]);

    expect(await h.modules.payments.submitRefunds()).toBeGreaterThanOrEqual(1);
    const submitted = (
      await kit.sql(`SELECT id, status, provider_refund_id FROM payments.refunds WHERE payment_id = $1`, [
        p.id,
      ])
    ).rows[0];
    expect(submitted.status).toBe('SUBMITTED');
    await webhook(fake.settleRefund(submitted.provider_refund_id, 'processed'));
    expect(
      (await kit.sql(`SELECT status FROM payments.refunds WHERE id = $1`, [submitted.id])).rows[0].status,
    ).toBe('SUCCEEDED');
    const listed = (await h.get(`/api/v1/bookings/${b.id}/payments`, c.cookie)).json();
    expect(listed.refunds).toMatchObject([
      { amountPaise: 8000, reason: 'LATE_PAYMENT_UNAVAILABLE', status: 'SUCCEEDED' },
    ]);
  });

  it('a second successful payment for an already paid booking is refunded', async () => {
    const { c, b } = await holdFor(10);
    const first = (await pay(c, b.id)).json();
    // A second order (e.g. the first one expired on the client) and both get paid.
    await kit.sql(`UPDATE payments.payments SET created_at = now() - interval '40 minutes' WHERE id = $1`, [
      first.id,
    ]);
    const second = (await pay(c, b.id)).json();
    expect(second.id).not.toBe(first.id);
    await webhook(fake.simulate(first.checkout.orderId, 'captured'));
    await webhook(fake.simulate(second.checkout.orderId, 'captured'));
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
    const refund = await kit.sql(`SELECT reason, payment_id FROM payments.refunds WHERE booking_id = $1`, [
      b.id,
    ]);
    expect(refund.rows).toEqual([{ reason: 'DUPLICATE_PAYMENT', payment_id: second.id }]);
  });
});

describe('refunds', () => {
  it('a customer cancellation refunds the policy amount through the provider', async () => {
    const { c, b } = await holdFor(11, { asset: { cancellationPolicy: 'FLEXIBLE' } });
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    const cancelled = await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect(cancelled.json().cancellation.refundPaise).toBe(8000);
    const r = (await kit.sql(`SELECT * FROM payments.refunds WHERE booking_id = $1`, [b.id])).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      reason: 'CUSTOMER_CANCELLED',
      status: 'PENDING',
      idempotency_key: `booking:${b.id}:cancel`,
    });
    await h.modules.payments.submitRefunds();
    await h.modules.payments.submitRefunds(); // no double submission
    expect([...fake.refunds.values()].filter((x) => x.receipt === r[0].id)).toHaveLength(1);
  });

  it('host cancellation refunds in full; unpaid cancellations create no refund', async () => {
    const { l, c, b } = await holdFor(12, { asset: { cancellationPolicy: 'STRICT' } });
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    await h.post(
      `/api/v1/host/bookings/${b.id}/cancel`,
      { reason: 'Gate under repair' },
      { cookie: l.host.cookie },
    );
    expect(
      (
        await kit.sql(`SELECT reason, amount_paise::int AS a FROM payments.refunds WHERE booking_id = $1`, [
          b.id,
        ])
      ).rows,
    ).toEqual([{ reason: 'HOST_CANCELLED', a: 8000 }]);

    const unpaid = await holdFor(13);
    await h.post(`/api/v1/bookings/${unpaid.b.id}/cancel`, {}, { cookie: unpaid.c.cookie });
    expect(
      (await kit.sql(`SELECT count(*)::int AS n FROM payments.refunds WHERE booking_id = $1`, [unpaid.b.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('refunds can never exceed what was captured', async () => {
    const { c, b } = await holdFor(14);
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    const insert = (amount: number) =>
      kit.sql(
        `INSERT INTO payments.refunds (id, payment_id, booking_id, amount_paise, reason, status, idempotency_key) VALUES ($1, $2, $3, $4, 'PLATFORM_CANCELLED', 'PENDING', $5)`,
        [randomUUID(), p.id, b.id, amount, randomUUID()],
      );
    await insert(5000);
    await expect(insert(3001)).rejects.toThrow(/exceed/);
  });

  it('a provider outage is retried, then handed to finance', async () => {
    const { c, b } = await holdFor(15, { asset: { cancellationPolicy: 'FLEXIBLE' } });
    const p = (await pay(c, b.id)).json();
    await webhook(fake.simulate(p.checkout.orderId, 'captured'));
    await h.modules.payments.submitRefunds(); // drain earlier tests' refunds so the injected outage hits ours
    await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    for (let i = 0; i < 5; i += 1) {
      fake.failNextRefund = true;
      await h.modules.payments.submitRefunds();
      fake.failNextRefund = false;
    }
    const r = (
      await kit.sql(`SELECT id, status, attempts FROM payments.refunds WHERE booking_id = $1`, [b.id])
    ).rows[0];
    expect(r).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(
      (
        await kit.sql(`SELECT kind FROM payments.reconciliation_items WHERE dedupe_key = $1`, [
          `refund-failed:${r.id}`,
        ])
      ).rows,
    ).toEqual([{ kind: 'REFUND_FAILED' }]);
  });
});

describe('reconciliation', () => {
  it('finds captured payments whose webhook never came, expires abandoned ones, and repairs stuck confirmations', async () => {
    const lost = await holdFor(16);
    const lostPay = (await pay(lost.c, lost.b.id)).json();
    fake.simulate(lostPay.checkout.orderId, 'captured');
    const abandoned = await holdFor(17);
    const abandonedPay = (await pay(abandoned.c, abandoned.b.id)).json();
    const stuck = await holdFor(18);
    const stuckPay = (await pay(stuck.c, stuck.b.id)).json();
    const hook = fake.simulate(stuckPay.checkout.orderId, 'captured');
    // Crash after marking success, before confirming the booking (test-only direct write).
    await kit.sql(
      `UPDATE payments.payments SET status = 'SUCCEEDED', succeeded_at = now(), provider_payment_id = $2 WHERE id = $1`,
      [stuckPay.id, hook.payment.paymentId],
    );
    await kit.sql(`UPDATE payments.payments SET created_at = now() - interval '3 minutes' WHERE id = $1`, [
      lostPay.id,
    ]);
    await kit.sql(`UPDATE payments.payments SET created_at = now() - interval '45 minutes' WHERE id = $1`, [
      abandonedPay.id,
    ]);

    expect(await h.modules.payments.reconcile()).toBeGreaterThanOrEqual(3);
    expect((await paymentRow(lostPay.id)).status).toBe('SUCCEEDED');
    expect(await bookingStatus(lost.c, lost.b.id)).toBe('CONFIRMED');
    expect((await paymentRow(abandonedPay.id)).status).toBe('EXPIRED');
    expect(await bookingStatus(stuck.c, stuck.b.id)).toBe('CONFIRMED');
    expect(
      (
        await kit.sql(`SELECT kind FROM payments.reconciliation_items WHERE dedupe_key = $1`, [
          `stuck:${stuckPay.id}`,
        ])
      ).rows,
    ).toEqual([{ kind: 'STUCK_CONFIRMATION' }]);
    // A late capture on the expired attempt is still honoured (the booking is held only while live).
    await webhook(fake.simulate(abandonedPay.checkout.orderId, 'captured'));
    expect((await paymentRow(abandonedPay.id)).status).toBe('SUCCEEDED');
  });

  it('imports settlements and flags payments it can not match', async () => {
    const n = await h.modules.payments.importSettlements('2026-10-19');
    expect(n).toBeGreaterThan(0);
    const lines = await kit.sql(`SELECT count(*)::int AS n FROM payments.settlement_lines`);
    expect(lines.rows[0].n).toBe(n);
    expect(await h.modules.payments.importSettlements('2026-10-19')).toBe(n); // idempotent import
    expect((await kit.sql(`SELECT count(*)::int AS n FROM payments.settlement_lines`)).rows[0].n).toBe(n);
    // The unknown-order capture from earlier settles too: flagged.
    const flagged = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.reconciliation_items WHERE dedupe_key LIKE 'settled-unknown:%'`,
    );
    expect(flagged.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('the reconciliation queue is for finance admins only', async () => {
    const trustAdmin = admin;
    expect((await h.get('/api/admin/v1/payments/reconciliation', trustAdmin)).statusCode).toBe(403);
    const finance = await h.adminSignIn(['FINANCE']);
    const res = await h.get('/api/admin/v1/payments/reconciliation', finance);
    expect(res.statusCode, res.body).toBe(200);
    const item = res.json()[0];
    const resolved = await h.post(
      `/api/admin/v1/payments/reconciliation/${item.id}/resolve`,
      { note: 'Checked with provider dashboard' },
      { cookie: finance },
    );
    expect(resolved.statusCode).toBe(204);
  });
});

describe('authorization', () => {
  it('only the booking customer can pay or see payments; other bookings are not payable', async () => {
    const { c, b } = await holdFor(19);
    const stranger = await kit.customer();
    expect((await pay(stranger, b.id)).statusCode).toBe(404);
    const p = (await pay(c, b.id)).json();
    expect((await h.get(`/api/v1/payments/${p.id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await h.get(`/api/v1/bookings/${b.id}/payments`, stranger.cookie)).statusCode).toBe(404);
    expect(
      (await h.post(`/api/v1/payments/${p.id}/return`, {}, { cookie: stranger.cookie })).statusCode,
    ).toBe(404);
    expect(
      (
        await h.post(
          `/api/v1/dev/fake-checkout/${p.id}`,
          { outcome: 'captured' },
          { cookie: stranger.cookie },
        )
      ).statusCode,
    ).toBe(404);
    const missingKey = await h.post(`/api/v1/bookings/${b.id}/payments`, {}, { cookie: c.cookie });
    expect(missingKey.json().code).toBe('payment.idempotency_key_required');
    // A request awaiting the host can't be paid yet.
    const l = await kit.listing(20, { asset: { approvalRequired: true } });
    const r = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect((await pay(c, r.id)).json().code).toBe('payment.booking_not_payable');
  });

  it('the simulated checkout goes through the same signed webhook path', async () => {
    const { c, b } = await holdFor(21);
    const p = (await pay(c, b.id)).json();
    const res = await h.post(
      `/api/v1/dev/fake-checkout/${p.id}`,
      { outcome: 'captured' },
      { cookie: c.cookie },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await bookingStatus(c, b.id)).toBe('CONFIRMED');
    const stored = await kit.sql(
      `SELECT count(*)::int AS n FROM payments.provider_events WHERE payload::text LIKE $1`,
      [`%${p.checkout.orderId}%`],
    );
    expect(stored.rows[0].n).toBe(1);
  });
});
