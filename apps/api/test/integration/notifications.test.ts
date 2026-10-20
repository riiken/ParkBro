import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryMessaging } from '../../src/modules/notifications/index.ts';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { at, bookingKit, IST, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let kit: ReturnType<typeof bookingKit>;
const pay = fakeProvider();
const msg = memoryMessaging();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: pay, messaging: msg });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

type Customer = Awaited<ReturnType<typeof kit.customer>>;

/** Deliver everything that is due now, so failure injection below hits only the rows under test. */
async function drain() {
  msg.clearFailures();
  await kit.sql(`UPDATE notifications.notifications SET next_attempt_at = now() WHERE status = 'PENDING'`);
  await h.modules.notifications.deliver();
}
/** Make every currently due external message fail once with `kind`. */
async function failDue(kind: 'transient' | 'permanent') {
  const n = (
    await kit.sql(
      `SELECT count(*)::int AS n FROM notifications.notifications WHERE status = 'PENDING' AND next_attempt_at <= now()`,
    )
  ).rows[0].n;
  msg.failNext(kind, n);
}
const rows = async (userId: string, template?: string) =>
  (
    await kit.sql(
      `SELECT * FROM notifications.notifications WHERE user_id = $1 ${template ? 'AND template = $2' : ''} ORDER BY created_at, channel`,
      template ? [userId, template] : [userId],
    )
  ).rows;

async function paidBooking(seed: number, opts: { start?: string; end?: string } = {}) {
  const l = await kit.listing(seed, {
    units: ['N1', 'N2'],
    title: `Notify spot ${'abcdefghijklmnop'[seed % 16]}`,
  });
  const c = await kit.customer();
  const day = istDay(3);
  const b = await kit.booked(c, l.assetId, opts.start ?? at(day, '10:00'), opts.end ?? at(day, '12:00'));
  const p = (
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${b.id}/payments`,
      headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
    })
  ).json();
  const hook = pay.simulate(p.checkout.orderId, 'captured');
  await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
  return { l, c, b };
}

describe('outbox from events', () => {
  it('a confirmed booking notifies the customer and the host, in-app and on WhatsApp, without personal data', async () => {
    const { l, c, b } = await paidBooking(1);
    const mine = await rows(c.userId, 'booking.confirmed.customer');
    expect(mine.map((r) => `${r.channel}:${r.status}`)).toEqual(['IN_APP:SENT', 'WHATSAPP:PENDING']);
    // Only references and times: never a phone, access code or address.
    expect(Object.keys(mine[0].vars).sort()).toEqual(['at', 'bookingId']);
    expect((await rows(c.userId, 'payment.received.customer')).length).toBe(2);
    expect((await rows(l.host.userId, 'booking.confirmed.host')).map((r) => r.channel)).toEqual([
      'IN_APP',
      'WHATSAPP',
    ]);

    const inbox = (await h.get('/api/v1/me/notifications', c.cookie)).json();
    expect(inbox.unread).toBe(2);
    const confirmed = inbox.items.find((i: { title: string }) => i.title === 'Booking confirmed');
    expect(confirmed.body).toMatch(
      /^Notify spot b on .+ at 10:00 am\. Your access details are in the app\.$/,
    );
    expect(confirmed.link).toBe(`/bookings/${b.id}`);
  });

  it('the worker delivers once, retries transient failures with backoff and stops on permanent ones', async () => {
    await drain();
    const { c } = await paidBooking(2);
    const before = msg.sent.length;
    await failDue('transient'); // every due message fails once
    await h.modules.notifications.deliver();
    const pending = (await rows(c.userId)).filter((r) => r.channel === 'WHATSAPP');
    expect(
      pending.every((r) => r.status === 'PENDING' && r.attempts === 1 && r.last_error === 'provider timeout'),
    ).toBe(true);
    for (const r of pending)
      expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
    await kit.sql(`UPDATE notifications.notifications SET next_attempt_at = now() WHERE status = 'PENDING'`);
    await h.modules.notifications.deliver();
    await h.modules.notifications.deliver();
    const after = (await rows(c.userId)).filter((r) => r.channel === 'WHATSAPP');
    expect(after.every((r) => r.status === 'SENT')).toBe(true);
    const mineSent = msg.sent.slice(before).filter((m) => m.to === `+91${c.phone}`);
    expect(mineSent.map((m) => m.template).sort()).toEqual([
      'booking.confirmed.customer',
      'payment.received.customer',
    ]);
    expect(mineSent[0]?.text).toMatch(/^ParkBro: /);

    await drain();
    const { c: c2 } = await paidBooking(3);
    await failDue('permanent');
    await h.modules.notifications.deliver();
    const failed = (await rows(c2.userId)).filter((r) => r.channel === 'WHATSAPP');
    expect(failed.map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('a message that keeps failing is given up after the last retry', async () => {
    await drain();
    const { c } = await paidBooking(4);
    for (let i = 0; i < 6; i += 1) {
      await kit.sql(
        `UPDATE notifications.notifications SET next_attempt_at = now() WHERE status = 'PENDING'`,
      );
      await failDue('transient');
      await h.modules.notifications.deliver();
    }
    msg.clearFailures();
    const final = (await rows(c.userId)).filter((r) => r.channel === 'WHATSAPP');
    expect(final.map((r) => [r.status, r.attempts])).toEqual([
      ['FAILED', 6],
      ['FAILED', 6],
    ]);
  });

  it('delivery receipts move SENT → DELIVERED once, signed only', async () => {
    await drain();
    const { c } = await paidBooking(5);
    await h.modules.notifications.deliver();
    const sent = (await rows(c.userId)).find((r) => r.channel === 'WHATSAPP' && r.status === 'SENT');
    const hook = msg.deliveryWebhook(sent.provider_message_id, 'DELIVERED');
    const post = (body: string, headers: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: '/api/v1/webhooks/messaging/memory', headers, payload: body });
    expect((await post(hook.rawBody, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect((await post(hook.rawBody, hook.headers)).json()).toEqual({ updated: 1 });
    expect((await post(hook.rawBody, hook.headers)).json()).toEqual({ updated: 0 });
    expect(
      (await kit.sql(`SELECT status, delivered_at FROM notifications.notifications WHERE id = $1`, [sent.id]))
        .rows[0].status,
    ).toBe('DELIVERED');
  });
});

describe('preferences and critical messages', () => {
  it('opt-outs move to SMS or in-app only; a host is always told a customer is stuck', async () => {
    const l = await kit.listing(6, { units: ['P1'], accessInstructions: 'x' });
    const c = await kit.customer();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: { ...CSRF, cookie: c.cookie },
      payload: { whatsapp: false },
    });
    expect(res.json()).toEqual({ whatsapp: false, sms: true, email: true, push: true });
    for (const cookie of [l.host.cookie]) {
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/me/notification-preferences',
        headers: { ...CSRF, cookie },
        payload: { whatsapp: false, sms: false },
      });
    }
    const start = DateTime.now().setZone(IST).plus({ minutes: 2 }).startOf('minute');
    const b = await kit.booked(c, l.assetId, start.toISO() ?? '', start.plus({ hours: 1 }).toISO() ?? '');
    await h.modules.booking.confirmPayment(b.id, 'test');
    expect((await rows(c.userId, 'booking.confirmed.customer')).map((r) => r.channel)).toEqual([
      'IN_APP',
      'SMS',
    ]);
    expect((await rows(l.host.userId, 'booking.confirmed.host')).map((r) => r.channel)).toEqual(['IN_APP']);
    await h.post(`/api/v1/bookings/${b.id}/issues`, { kind: 'ACCESS_DENIED' }, { cookie: c.cookie });
    const critical = await rows(l.host.userId, 'issue.opened.host');
    expect(critical.map((r) => `${r.category}:${r.channel}`)).toEqual(['CRITICAL:IN_APP', 'CRITICAL:SMS']);
  });

  it('requests, approvals, cancellations and refunds reach the right people', async () => {
    const l = await kit.listing(7, {
      units: ['Q1'],
      asset: { approvalRequired: true, cancellationPolicy: 'FLEXIBLE' },
    });
    const c = await kit.customer();
    const day = istDay(3);
    const b = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'));
    expect((await rows(l.host.userId, 'booking.requested.host'))[0]).toMatchObject({ category: 'CRITICAL' });
    await h.post(`/api/v1/host/bookings/${b.id}/approve`, {}, { cookie: l.host.cookie });
    expect(await rows(c.userId, 'booking.approved.customer')).toHaveLength(2);
    const p = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${b.id}/payments`,
        headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
      })
    ).json();
    const hook = pay.simulate(p.checkout.orderId, 'captured');
    await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
    await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect(await rows(c.userId, 'booking.cancelled.customer')).toHaveLength(2);
    expect(await rows(l.host.userId, 'booking.cancelled.host')).toHaveLength(2);
    expect(await rows(c.userId, 'refund.started.customer')).toHaveLength(2);
    await h.modules.payments.submitRefunds();
    const refund = (
      await kit.sql(`SELECT provider_refund_id FROM payments.refunds WHERE booking_id = $1`, [b.id])
    ).rows[0];
    const done = pay.settleRefund(refund.provider_refund_id, 'processed');
    await h.modules.payments.handleWebhook(done.rawBody, done.headers, 'test');
    expect(await rows(c.userId, 'refund.completed.customer')).toHaveLength(2);
    const inbox = (await h.get('/api/v1/me/notifications', c.cookie)).json();
    expect(inbox.items.find((i: { title: string }) => i.title === 'Booking cancelled').body).toContain(
      'Refund: ₹40',
    );
  });
});

describe('time-based and inbox', () => {
  it('reminder, start and ending-soon are sent once each', async () => {
    const l = await kit.listing(8, { units: ['R1'] });
    const c = await kit.customer();
    const start = DateTime.now().setZone(IST).plus({ minutes: 40 }).startOf('minute');
    const b = await kit.booked(c, l.assetId, start.toISO() ?? '', start.plus({ hours: 2 }).toISO() ?? '');
    await h.modules.booking.confirmPayment(b.id, 'test');
    await kit.sql(`UPDATE booking.bookings SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      b.id,
    ]);
    await h.modules.notifications.schedule();
    await h.modules.notifications.schedule();
    expect(await rows(c.userId, 'booking.reminder.customer')).toHaveLength(2); // in-app + WhatsApp, once
    // Now it starts (test time travel), then it is about to end.
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '5 minutes', now() + interval '2 hours', '[)') WHERE id = $1`,
      [b.id],
    );
    await h.modules.notifications.schedule();
    expect(await rows(c.userId, 'booking.started.customer')).toHaveLength(2);
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '2 hours', now() + interval '10 minutes', '[)') WHERE id = $1`,
      [b.id],
    );
    await h.modules.notifications.schedule();
    await h.modules.notifications.schedule();
    expect(await rows(c.userId, 'booking.ending.customer')).toHaveLength(2);
  });

  it('the inbox is private and can be marked read', async () => {
    const { c } = await paidBooking(9);
    const other: Customer = await kit.customer();
    expect((await h.get('/api/v1/me/notifications', other.cookie)).json()).toEqual({ unread: 0, items: [] });
    const inbox = (await h.get('/api/v1/me/notifications', c.cookie)).json();
    const first = inbox.items[0].id;
    // Another user can't mark mine.
    await h.post('/api/v1/me/notifications/read', { ids: [first] }, { cookie: other.cookie });
    expect((await h.get('/api/v1/me/notifications', c.cookie)).json().unread).toBe(inbox.unread);
    await h.post('/api/v1/me/notifications/read', { ids: [first] }, { cookie: c.cookie });
    expect((await h.get('/api/v1/me/notifications', c.cookie)).json().unread).toBe(inbox.unread - 1);
    await h.post('/api/v1/me/notifications/read', { all: true }, { cookie: c.cookie });
    expect((await h.get('/api/v1/me/notifications', c.cookie)).json().unread).toBe(0);
  });
});
