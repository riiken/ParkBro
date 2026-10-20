import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '../../src/modules/payments/index.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let finance: string;
let kit: ReturnType<typeof bookingKit>;
const fake = fakeProvider();

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, paymentProvider: fake });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  finance = await h.adminSignIn(['FINANCE']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const day = istDay(4);
type Listing = Awaited<ReturnType<typeof kit.listing>>;

/** A paid booking (default ₹80 = 2 h × ₹40, no service fee, 10% commission → host net ₹72; 3 h → ₹108). */
async function paidBooking(l: Listing, start = '10:00', end = '12:00') {
  const c = await kit.customer();
  const b = await kit.booked(c, l.assetId, at(day, start), at(day, end));
  const p = (
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${b.id}/payments`,
      headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
    })
  ).json();
  const hook = fake.simulate(p.checkout.orderId, 'captured');
  await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
  return { c, b, paymentId: p.id as string };
}

const earnings = async (cookie: string) => (await h.get('/api/v1/host/earnings', cookie)).json();
const trial = async () => (await h.get('/api/admin/v1/ledger/trial-balance', finance)).json();

/** Test-only time travel: the booking ended `hours` ago and was completed. */
async function endedHoursAgo(bookingId: string, hours: number) {
  await kit.sql(
    `UPDATE booking.bookings SET period = tstzrange(now() - make_interval(hours => $2 + 2), now() - make_interval(hours => $2), '[)') WHERE id = $1`,
    [bookingId, hours],
  );
  await h.modules.booking.completeFinished();
}

async function verifiedPayoutAccount(l: Listing) {
  const put = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/host/payout-account',
    headers: { ...CSRF, cookie: l.host.cookie },
    payload: { method: 'UPI', holderName: 'Asha Rao', vpa: `asha${randomUUID().slice(0, 6)}@okbank` },
  });
  expect(put.statusCode, put.body).toBe(200);
  const res = await h.post(
    `/api/admin/v1/payout-accounts/${put.json().id}/review`,
    { decision: 'VERIFIED' },
    { cookie: finance },
  );
  expect(res.statusCode, res.body).toBe(204);
}

describe('capture and refund postings', () => {
  it('a captured payment splits into commission and host pending; the ledger balances', async () => {
    const l = await kit.listing(1, { units: ['E1'] });
    await paidBooking(l);
    const e = await earnings(l.host.cookie);
    expect(e.balances).toEqual({
      pendingPaise: 7200,
      availablePaise: 0,
      inPayoutPaise: 0,
      paidPaise: 0,
      receivablePaise: 0,
    });
    expect(e.bookings[0]).toMatchObject({
      customerPaidPaise: 8000,
      grossPaise: 8000,
      commissionPaise: 800,
      serviceFeePaise: 0,
      taxPaise: 0,
      netPaise: 7200,
      status: 'PENDING',
    });
    const tb = await trial();
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a: { code: string }) => a.code === 'PLATFORM_COMMISSION')).toMatchObject({
      creditPaise: 800,
    });
  });

  it('a partial refund reverses the parts proportionally', async () => {
    const l = await kit.listing(2, { units: ['E1'], asset: { cancellationPolicy: 'STRICT' } }); // 2–7 days ahead: 50%
    const { c, b } = await paidBooking(l);
    const cancelled = await h.post(`/api/v1/bookings/${b.id}/cancel`, {}, { cookie: c.cookie });
    expect(cancelled.json().cancellation.refundPaise).toBe(4000);
    const e = await earnings(l.host.cookie);
    expect(e.balances.pendingPaise).toBe(3600);
    expect(e.bookings[0]).toMatchObject({
      customerPaidPaise: 8000,
      refundedPaise: 4000,
      commissionPaise: 400,
      netPaise: 3600,
    });
    expect((await trial()).balanced).toBe(true);
  });

  it('a late payment that is refunded in full leaves the host nothing', async () => {
    const l = await kit.listing(3, { units: ['E1'] });
    const c = await kit.customer();
    const b = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '12:00'));
    const p = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${b.id}/payments`,
        headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
      })
    ).json();
    await kit.sql(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    await kit.booked(await kit.customer(), l.assetId, at(day, '10:00'), at(day, '12:00'));
    const hook = fake.simulate(p.checkout.orderId, 'captured');
    await h.modules.payments.handleWebhook(hook.rawBody, hook.headers, 'test');
    const e = await earnings(l.host.cookie);
    expect(e.balances.pendingPaise).toBe(0);
    expect(e.bookings.find((x: { bookingId: string }) => x.bookingId === b.id)).toMatchObject({
      customerPaidPaise: 8000,
      refundedPaise: 8000,
      netPaise: 0,
    });
  });
});

describe('release, payouts and receivables', () => {
  it('earnings release 48 h after the booking ends, then pay out to a verified account', async () => {
    const l = await kit.listing(4, { units: ['E1'] });
    const { b } = await paidBooking(l, '10:00', '13:00');
    await endedHoursAgo(b.id, 47);
    await h.modules.earnings.releaseEarnings();
    expect((await earnings(l.host.cookie)).balances.availablePaise).toBe(0); // dispute window not over
    await endedHoursAgo(b.id, 49);
    expect(await h.modules.earnings.releaseEarnings()).toBeGreaterThanOrEqual(1);
    expect(await h.modules.earnings.releaseEarnings()).toBe(0); // idempotent
    expect((await earnings(l.host.cookie)).balances).toMatchObject({
      pendingPaise: 0,
      availablePaise: 10800,
    });
    expect((await earnings(l.host.cookie)).bookings[0].status).toBe('RELEASED');

    // No verified payout account yet: nothing is paid.
    await h.modules.earnings.runPayouts('2026-11-02');
    expect((await h.get('/api/v1/host/payouts', l.host.cookie)).json()).toEqual([]);
    await verifiedPayoutAccount(l);
    expect(await h.modules.earnings.runPayouts('2026-11-02')).toBeGreaterThanOrEqual(1);
    expect(await h.modules.earnings.runPayouts('2026-11-02')).toBe(0); // one open payout per host, idempotent per run
    const payouts = (await h.get('/api/v1/host/payouts', l.host.cookie)).json();
    expect(payouts).toMatchObject([{ amountPaise: 10800, status: 'PROCESSING' }]);
    expect((await earnings(l.host.cookie)).balances).toMatchObject({
      availablePaise: 0,
      inPayoutPaise: 10800,
    });

    // Finance sends the transfer and records the reference.
    expect(
      (
        await h.post(
          `/api/admin/v1/payouts/${payouts[0].id}/settle`,
          { status: 'PAID', reference: 'UTR123456' },
          { cookie: admin },
        )
      ).statusCode,
    ).toBe(403);
    const settled = await h.post(
      `/api/admin/v1/payouts/${payouts[0].id}/settle`,
      { status: 'PAID', reference: 'UTR123456' },
      { cookie: finance },
    );
    expect(settled.statusCode, settled.body).toBe(204);
    expect(
      (
        await h.post(
          `/api/admin/v1/payouts/${payouts[0].id}/settle`,
          { status: 'PAID', reference: 'UTR999999' },
          { cookie: finance },
        )
      ).json().code,
    ).toBe('payout.transition_not_allowed');
    expect((await earnings(l.host.cookie)).balances).toMatchObject({ inPayoutPaise: 0, paidPaise: 10800 });
    expect((await h.get('/api/v1/host/payouts', l.host.cookie)).json()[0]).toMatchObject({
      status: 'PAID',
      reference: 'UTR123456',
    });
    expect((await trial()).balanced).toBe(true);
  });

  it('a refund after payout becomes a receivable, offset from the next payout (BR-19)', async () => {
    const l = await kit.listing(5, { units: ['E1', 'E2'], asset: { cancellationPolicy: 'FLEXIBLE' } });
    const first = await paidBooking(l, '10:00', '13:00');
    await endedHoursAgo(first.b.id, 50);
    await h.modules.earnings.releaseEarnings();
    await verifiedPayoutAccount(l);
    await h.modules.earnings.runPayouts('2026-11-09');
    const [p1] = (await h.get('/api/v1/host/payouts', l.host.cookie)).json();
    await h.post(
      `/api/admin/v1/payouts/${p1.id}/settle`,
      { status: 'PAID', reference: 'UTR-A-0001' },
      { cookie: finance },
    );

    // Support refunds the first booking after it was paid out (test: a platform cancellation stands in for a dispute).
    const refundId = randomUUID();
    await kit.sql(
      `INSERT INTO payments.refunds (id, payment_id, booking_id, amount_paise, reason, status, idempotency_key) VALUES ($1, $2, $3, 12000, 'PLATFORM_CANCELLED', 'PENDING', $4)`,
      [refundId, first.paymentId, first.b.id, `dispute:${refundId}`],
    );
    expect(await h.modules.earnings.backfill()).toBeGreaterThanOrEqual(1); // the refund journal (no event for a direct insert)
    expect((await earnings(l.host.cookie)).balances.receivablePaise).toBe(10800);

    // A new booking earns ₹108 and is released; the payout run offsets the receivable first.
    const second = await paidBooking(l, '14:00', '17:00');
    await endedHoursAgo(second.b.id, 60);
    await h.modules.earnings.releaseEarnings();
    await h.modules.earnings.runPayouts('2026-11-16');
    const e = await earnings(l.host.cookie);
    expect(e.balances).toMatchObject({ receivablePaise: 0, availablePaise: 0, inPayoutPaise: 0 });
    expect((await h.get('/api/v1/host/payouts', l.host.cookie)).json()).toHaveLength(1); // nothing left to pay
    expect((await trial()).balanced).toBe(true);
  });

  it('a failed payout returns the money to available', async () => {
    const l = await kit.listing(6, { units: ['E1'] });
    const { b } = await paidBooking(l, '10:00', '13:00');
    await endedHoursAgo(b.id, 50);
    await h.modules.earnings.releaseEarnings();
    await verifiedPayoutAccount(l);
    await h.modules.earnings.runPayouts('2026-11-23');
    const [p] = (await h.get('/api/v1/host/payouts', l.host.cookie)).json();
    await h.post(
      `/api/admin/v1/payouts/${p.id}/settle`,
      { status: 'FAILED', reason: 'Account closed' },
      { cookie: finance },
    );
    expect((await earnings(l.host.cookie)).balances).toMatchObject({
      availablePaise: 10800,
      inPayoutPaise: 0,
    });
  });
});

describe('payout accounts', () => {
  it('details are encrypted and masked; a change holds payouts for 72 hours', async () => {
    const l = await kit.listing(7, { units: ['E1'] });
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/host/payout-account',
      headers: { ...CSRF, cookie: l.host.cookie },
      payload: { method: 'BANK', holderName: 'Asha Rao', accountNumber: '12', ifsc: 'HDFC0001234' },
    });
    expect(bad.statusCode).toBe(400);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/host/payout-account',
      headers: { ...CSRF, cookie: l.host.cookie },
      payload: {
        method: 'BANK',
        holderName: 'Asha Rao',
        accountNumber: '50100012345678',
        ifsc: 'hdfc0001234',
      },
    });
    expect(put.json()).toMatchObject({
      method: 'BANK',
      display: 'A/c ••••5678 · HDFC0001234',
      status: 'PENDING_VERIFICATION',
      holdUntil: null,
    });
    const raw = await kit.sql(`SELECT details_enc::text AS d FROM payouts.payout_accounts WHERE id = $1`, [
      put.json().id,
    ]);
    expect(raw.rows[0].d).not.toContain('50100012345678');
    // Finance sees the full details to verify; nobody else does.
    const pending = (await h.get('/api/admin/v1/payout-accounts/pending', finance)).json();
    expect(pending.find((a: { id: string }) => a.id === put.json().id).details).toBe(
      '50100012345678|HDFC0001234',
    );
    expect((await h.get('/api/admin/v1/payout-accounts/pending', admin)).statusCode).toBe(403);
    await h.post(
      `/api/admin/v1/payout-accounts/${put.json().id}/review`,
      { decision: 'VERIFIED' },
      { cookie: finance },
    );

    const { b } = await paidBooking(l, '10:00', '13:00');
    await endedHoursAgo(b.id, 50);
    await h.modules.earnings.releaseEarnings();
    // The host switches to UPI: a 72-hour hold applies once re-verified.
    const change = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/host/payout-account',
      headers: { ...CSRF, cookie: l.host.cookie },
      payload: { method: 'UPI', holderName: 'Asha Rao', vpa: 'asha.rao@okbank' },
    });
    expect(change.json()).toMatchObject({ method: 'UPI', status: 'PENDING_VERIFICATION' });
    expect(new Date(change.json().holdUntil).getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    await h.post(
      `/api/admin/v1/payout-accounts/${change.json().id}/review`,
      { decision: 'VERIFIED' },
      { cookie: finance },
    );
    await h.modules.earnings.runPayouts('2026-11-30');
    expect((await h.get('/api/v1/host/payouts', l.host.cookie)).json()).toEqual([]);
    expect((await h.get('/api/v1/host/payout-account', l.host.cookie)).json().display).toBe('••••.rao');
    const audit = await kit.sql(`SELECT action FROM platform.audit_events WHERE entity_id = $1 ORDER BY id`, [
      l.host.hostAccountId,
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['payout_account.added', 'payout_account.changed']),
    );
  });

  it('only hosts see their own earnings; customers and other hosts see nothing', async () => {
    const l = await kit.listing(8, { units: ['E1'] });
    await paidBooking(l);
    const other = await h.hostSignUp();
    expect((await earnings(other.cookie)).bookings).toEqual([]);
    const customer = await kit.customer();
    expect((await h.get('/api/v1/host/earnings', customer.cookie)).json().code).toBe('host.not_a_host');
  });
});

describe('ledger integrity', () => {
  it('entries and journals are append-only and every journal must balance', async () => {
    await expect(kit.sql(`UPDATE ledger.entries SET amount_paise = 1`)).rejects.toThrow();
    await expect(kit.sql(`DELETE FROM ledger.journals`)).rejects.toThrow();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const j = randomUUID();
      await client.query(
        `INSERT INTO ledger.journals (id, kind, idempotency_key) VALUES ($1, 'REFUND', $2)`,
        [j, `test:${j}`],
      );
      const acct = (await client.query(`SELECT id FROM ledger.accounts WHERE code = 'CUSTOMER_CLEARING'`))
        .rows[0].id;
      await client.query(
        `INSERT INTO ledger.entries (journal_id, account_id, direction, amount_paise) VALUES ($1, $2, 'DEBIT', 100)`,
        [j, acct],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/not balanced/);
    } finally {
      client.release();
    }
    expect((await trial()).balanced).toBe(true);
  });

  it('the backfill job posts captures that missed their event, once', async () => {
    const l = await kit.listing(9, { units: ['E1'] });
    const c = await kit.customer();
    const b = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '12:00'));
    const p = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${b.id}/payments`,
        headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': randomUUID() },
      })
    ).json();
    await kit.sql(`UPDATE payments.payments SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = $1`, [
      p.id,
    ]);
    expect((await earnings(l.host.cookie)).balances.pendingPaise).toBe(0);
    expect(await h.modules.earnings.backfill()).toBeGreaterThanOrEqual(1);
    expect(await h.modules.earnings.backfill()).toBe(0);
    expect((await earnings(l.host.cookie)).balances.pendingPaise).toBe(7200);
  });
});
