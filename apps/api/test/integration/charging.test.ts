import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChargerIntegration } from '../../src/modules/charging/index.ts';
import { at, bookingKit, IST, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
let kit: ReturnType<typeof bookingKit>;

/** A controllable stand-in for a smart charger (the seam a real OCPP adapter will use). */
const charger = { accept: true, energyWh: null as number | null, starts: 0, stops: 0 };
const fakeIntegration: ChargerIntegration = {
  kind: 'MANUAL',
  metering: 'NONE',
  getStatus: async () => 'UNKNOWN',
  startSession: async () => {
    charger.starts += 1;
    return { accepted: charger.accept, externalRef: charger.accept ? `ext-${charger.starts}` : null };
  },
  stopSession: async () => {
    charger.stops += 1;
  },
  readEnergy: async () => charger.energyWh,
};

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, chargerIntegrations: { MANUAL: fakeIntegration } });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => admin, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const ev = (seed: number) =>
  kit.listing(seed, {
    type: 'EV_CHARGING',
    charger: { connectors: ['TYPE2'], currentType: 'AC', powerKw: 7.4 },
    units: ['C1', 'C2', 'C3'],
    asset: { minMinutes: 30, maxMinutes: 480 },
  });
const evDriver = () => kit.customer({ isEv: true, connectors: ['TYPE2'] });

/** A confirmed charging booking starting in the next minute (inside the start window). */
async function chargingNow(l: Awaited<ReturnType<typeof ev>>, c: Awaited<ReturnType<typeof evDriver>>) {
  const start = DateTime.now().setZone(IST).plus({ minutes: 2 }).startOf('minute');
  const b = await kit.booked(
    c,
    l.assetId,
    start.toISO() ?? '',
    start.plus({ hours: 2 }).toISO() ?? '',
    'CHARGING_SESSION',
  );
  expect(await h.modules.booking.confirmPayment(b.id, 'test')).toEqual({ confirmed: true });
  return b;
}
const post = (c: { cookie: string }, id: string, action: string, body: object = {}) =>
  h.post(`/api/v1/bookings/${id}/charging/${action}`, body, { cookie: c.cookie });
const view = async (cookie: string, id: string, host = false) =>
  h.get(`/api/v1/${host ? 'host/' : ''}bookings/${id}/charging`, cookie);

describe('charging session', () => {
  it('starts and stops within a confirmed booking, through the charger integration', async () => {
    const l = await ev(1);
    const c = await evDriver();
    const b = await chargingNow(l, c);

    const before = await view(c.cookie, b.id);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      status: 'NOT_STARTED',
      charger: {
        connectors: ['TYPE2'],
        currentType: 'AC',
        powerKw: 7.4,
        speed: 'FAST',
        integration: 'MANUAL',
      },
      metering: 'NONE',
      maxEnergyKwhForBooking: 14.5, // 7.4 kW × 2 h = 14.8 → 14.5 (planning bound)
      actions: { canStart: true, canStop: false, canReportFault: true },
    });

    const started = await post(c, b.id, 'start');
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ status: 'CHARGING', actions: { canStart: false, canStop: true } });
    expect(started.json().startedAt).not.toBeNull();
    expect((await post(c, b.id, 'start')).json().code).toBe('charging.transition_not_allowed');

    charger.energyWh = 4200;
    const stopped = await post(c, b.id, 'stop');
    expect(stopped.json()).toMatchObject({ status: 'STOPPED_EARLY', energyKwh: 4.2 }); // before the booking end
    charger.energyWh = null;
    expect(charger.stops).toBeGreaterThanOrEqual(1);

    const events = await kit.sql(
      `SELECT e.from_status, e.to_status, e.actor_kind FROM charging.session_events e
       JOIN charging.charging_sessions s ON s.id = e.session_id WHERE s.booking_id = $1 ORDER BY e.id`,
      [b.id],
    );
    expect(events.rows).toEqual([
      { from_status: 'NOT_STARTED', to_status: 'CHARGING', actor_kind: 'CUSTOMER' },
      { from_status: 'CHARGING', to_status: 'STOPPED_EARLY', actor_kind: 'CUSTOMER' },
    ]);
    // Booking state is untouched by the session (the session never drives booking/payment/access).
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().status).toBe('CONFIRMED');
  });

  it('two simultaneous starts create one session and one start', async () => {
    const l = await ev(2);
    const c = await evDriver();
    const b = await chargingNow(l, c);
    const startsBefore = charger.starts;
    const [x, y] = await Promise.all([post(c, b.id, 'start'), post(c, b.id, 'start')]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect(charger.starts - startsBefore).toBe(1);
    const n = await kit.sql(
      `SELECT count(*)::int AS n FROM charging.charging_sessions WHERE booking_id = $1`,
      [b.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('needs a confirmed booking, inside its window, on a charger', async () => {
    const l = await ev(3);
    const c = await evDriver();
    // Unpaid hold.
    const start = DateTime.now().setZone(IST).plus({ minutes: 2 }).startOf('minute');
    const hold = await kit.booked(
      c,
      l.assetId,
      start.toISO() ?? '',
      start.plus({ hours: 1 }).toISO() ?? '',
      'CHARGING_SESSION',
    );
    expect((await post(c, hold.id, 'start')).json().code).toBe('charging.booking_not_active');
    // Confirmed but days away.
    const day = istDay(3);
    const later = await kit.booked(c, l.assetId, at(day, '10:00'), at(day, '11:00'), 'CHARGING_SESSION');
    await h.modules.booking.confirmPayment(later.id, 'test');
    expect((await view(c.cookie, later.id)).json().actions.canStart).toBe(false);
    expect((await post(c, later.id, 'start')).json().code).toBe('charging.outside_window');
    // A parking booking has no charger.
    const park = await kit.listing(4);
    const driver = await kit.customer();
    const pb = await kit.booked(driver, park.assetId, at(day, '10:00'), at(day, '11:00'));
    expect((await view(driver.cookie, pb.id)).json().code).toBe('charging.not_an_ev_booking');
  });

  it('a refusing charger keeps the session not started; a fault is recorded and audited', async () => {
    const l = await ev(5);
    const c = await evDriver();
    const b = await chargingNow(l, c);
    charger.accept = false;
    const refused = await post(c, b.id, 'start');
    charger.accept = true;
    expect(refused.statusCode).toBe(502);
    expect(refused.json().code).toBe('charging.charger_refused');
    expect((await view(c.cookie, b.id)).json().status).toBe('NOT_STARTED');

    const fault = await post(c, b.id, 'fault', { reason: 'NO_POWER', note: 'Socket is dead' });
    expect(fault.statusCode, fault.body).toBe(200);
    expect(fault.json()).toMatchObject({
      status: 'FAULTED',
      fault: { reason: 'NO_POWER' },
      actions: { canStart: false, canReportFault: false },
    });
    const audit = await kit.sql(`SELECT action FROM platform.audit_events WHERE entity_id = $1`, [b.id]);
    expect(audit.rows.map((r) => r.action)).toContain('charging.fault_reported');
    // V18: the fault opened a recourse issue (fixed within 15 minutes or refunded).
    expect((await h.get(`/api/v1/bookings/${b.id}`, c.cookie)).json().issue).toMatchObject({
      kind: 'CHARGER_FAULTY',
      status: 'OPEN',
    });
    expect((await post(c, b.id, 'fault', { reason: 'OTHER' })).json().code).toBe(
      'charging.transition_not_allowed',
    );
  });

  it('only the booking customer acts; the host can view; strangers see nothing', async () => {
    const l = await ev(6);
    const c = await evDriver();
    const b = await chargingNow(l, c);
    const stranger = await evDriver();
    expect((await view(stranger.cookie, b.id)).statusCode).toBe(404);
    expect((await post(stranger, b.id, 'start')).statusCode).toBe(404);
    expect((await post(l.host, b.id, 'start')).statusCode).toBe(404); // hosts don't drive the session
    const hostView = await view(l.host.cookie, b.id, true);
    expect(hostView.statusCode, hostView.body).toBe(200);
    expect(hostView.json().status).toBe('NOT_STARTED');
    const otherHost = await h.hostSignUp();
    expect((await view(otherHost.cookie, b.id, true)).statusCode).toBe(404);
  });

  it('the job completes sessions whose booking ended and stops those whose booking was cancelled', async () => {
    const l = await ev(7);
    const [a, b] = await Promise.all([evDriver(), evDriver()]);
    const ended = await chargingNow(l, a);
    const cancelled = await chargingNow(l, b);
    await post(a, ended.id, 'start');
    await post(b, cancelled.id, 'start');
    await kit.sql(
      `UPDATE booking.bookings SET period = tstzrange(now() - interval '3 hours', now() - interval '1 hour', '[)') WHERE id = $1`,
      [ended.id],
    );
    await h.post(
      `/api/v1/host/bookings/${cancelled.id}/cancel`,
      { reason: 'Charger maintenance' },
      { cookie: l.host.cookie },
    );
    expect(await h.modules.charging.closeFinished()).toBe(2);
    const done = (await view(a.cookie, ended.id)).json();
    expect(done.status).toBe('COMPLETED');
    const end = await kit.sql(
      `SELECT extract(epoch FROM upper(period)) * 1000 AS e FROM booking.bookings WHERE id = $1`,
      [ended.id],
    );
    // Ends at the booking end, never before the start (time travel here moved the end before the start).
    expect(new Date(done.endedAt).getTime()).toBe(
      Math.max(Math.round(Number(end.rows[0].e)), new Date(done.startedAt).getTime()),
    );
    expect((await view(b.cookie, cancelled.id)).json().status).toBe('STOPPED_EARLY');
    expect(await h.modules.charging.closeFinished()).toBe(0);
  });
});
