import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reservation, ReservationSource } from '../../src/modules/availability/index.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';
import { publishListing } from './helpers/publish.ts';

// Controllable stand-in for Phase 12 bookings: the same seam the booking module will implement.
const reserved: Reservation[] = [];
const fakeReservations: ReservationSource = {
  holdingReservations: async (unitIds, from, to) =>
    reserved.filter((r) => unitIds.includes(r.unitId) && r.start < to && r.blockedUntil > from),
};

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;
const O = { latitude: 12.9352, longitude: 77.6245 };
const IST = 'Asia/Kolkata';
const nextMonday = DateTime.now().setZone(IST).plus({ weeks: 1 }).startOf('week');
const at = (day: DateTime, hm: string) => {
  const [hh, mm] = hm.split(':').map(Number);
  return day.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
};
const isoAt = (day: DateTime, hm: string) => at(day, hm).toISO() ?? '';

let house: Awaited<ReturnType<typeof publishListing>>;
let lot: Awaited<ReturnType<typeof publishListing>>;
let lotUnits: { id: string; label: string }[];

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0, reservations: fakeReservations });
  admin = await h.adminSignIn(['TRUST_SAFETY']);
  house = await publishListing(h, admin, {
    seed: 1,
    ...O,
    title: 'Weekday driveway',
    rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 }],
    rules: [{ weekdays: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '19:00' }],
    asset: { bufferMinutes: 15 },
  });
  lot = await publishListing(h, admin, {
    seed: 2,
    kind: 'COMMERCIAL',
    ...O,
    title: 'Two space lot',
    units: ['A1', 'A2'],
  });
  lotUnits = (await h.get(`/api/v1/host/assets/${lot.assetId}`, lot.host.cookie))
    .json()
    .units.filter((u: { status: string }) => u.status === 'ACTIVE');
});
beforeEach(() => {
  reserved.length = 0;
});
afterAll(async () => {
  await h.close();
  await db.drop();
});

const exception = (cookie: string, assetId: string, body: object) =>
  h.app.inject({
    method: 'POST',
    url: `/api/v1/host/assets/${assetId}/availability-exceptions`,
    headers: { ...CSRF, cookie },
    payload: body,
  });
const check = async (assetId: string, start: string, end: string, mode?: string) => {
  const q = new URLSearchParams({ start, end, ...(mode ? { mode } : {}) });
  const res = await h.get(`/api/v1/listings/${assetId}/availability?${q}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { available: boolean; reason?: string };
};

describe('window check (public)', () => {
  it('reports CLOSED, LEAD_TIME and DURATION; rejects an unsupported mode; 404 for unknown listings', async () => {
    expect(await check(house.assetId, isoAt(nextMonday, '10:00'), isoAt(nextMonday, '12:00'))).toEqual({
      available: true,
    });
    const saturday = nextMonday.plus({ days: 5 });
    expect(await check(house.assetId, isoAt(saturday, '10:00'), isoAt(saturday, '12:00'))).toEqual({
      available: false,
      reason: 'CLOSED',
    });
    expect(
      await check(house.assetId, isoAt(nextMonday, '10:00'), isoAt(nextMonday, '10:30'), 'HOURLY'),
    ).toEqual({ available: false, reason: 'DURATION' });
    const past = DateTime.now().setZone(IST).minus({ days: 1 });
    expect(await check(house.assetId, isoAt(past, '10:00'), isoAt(past, '11:00'))).toEqual({
      available: false,
      reason: 'LEAD_TIME',
    });
    const monthly = await h.get(
      `/api/v1/listings/${house.assetId}/availability?start=${encodeURIComponent(isoAt(nextMonday, '10:00'))}&end=${encodeURIComponent(isoAt(nextMonday, '12:00'))}&mode=MONTHLY`,
    );
    expect(monthly.statusCode).toBe(400);
    expect(
      (
        await h.get(
          `/api/v1/listings/01a1568b-0000-7000-8000-000000000000/availability?start=${encodeURIComponent(isoAt(nextMonday, '10:00'))}&end=${encodeURIComponent(isoAt(nextMonday, '11:00'))}`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('is evaluated in the property timezone whatever offset the client sends', async () => {
    const utc10ist = at(nextMonday, '10:00').toUTC().toISO() ?? ''; // 04:30Z
    const utc11ist = at(nextMonday, '11:00').toUTC().toISO() ?? '';
    expect(await check(house.assetId, utc10ist, utc11ist)).toEqual({ available: true });
  });
});

describe('host blocks and openings', () => {
  it('a block makes the window unavailable (BLOCKED), end-exclusive, and disappears from windowed search', async () => {
    const res = await exception(house.host.cookie, house.assetId, {
      kind: 'BLOCK',
      start: isoAt(nextMonday, '13:00'),
      end: isoAt(nextMonday, '15:00'),
      reason: 'Family visiting SECRETREASON',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await check(house.assetId, isoAt(nextMonday, '12:00'), isoAt(nextMonday, '14:00'))).toEqual({
      available: false,
      reason: 'BLOCKED',
    });
    expect(await check(house.assetId, isoAt(nextMonday, '15:00'), isoAt(nextMonday, '16:00'))).toEqual({
      available: true,
    });

    const search = (start: string, end: string) =>
      h.get(
        `/api/v1/listings/search?lat=${O.latitude}&lng=${O.longitude}&type=PARKING&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
    const blocked = await search(isoAt(nextMonday, '13:30'), isoAt(nextMonday, '14:30'));
    expect(blocked.json().results.map((r: { id: string }) => r.id)).not.toContain(house.assetId);
    const free = await search(isoAt(nextMonday, '16:00'), isoAt(nextMonday, '17:00'));
    expect(free.json().results.map((r: { id: string }) => r.id)).toContain(house.assetId);

    // Block reasons are host-only.
    expect(blocked.body).not.toContain('SECRETREASON');
    expect((await h.get(`/api/v1/listings/${house.assetId}`)).body).not.toContain('SECRETREASON');
  });

  it('a unit-scoped block leaves the other space bookable until both are blocked', async () => {
    const day = nextMonday.plus({ days: 1 });
    const [a1, a2] = lotUnits;
    await exception(lot.host.cookie, lot.assetId, {
      kind: 'BLOCK',
      start: isoAt(day, '10:00'),
      end: isoAt(day, '12:00'),
      unitId: a1?.id,
    });
    expect(await check(lot.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).toEqual({ available: true });
    await exception(lot.host.cookie, lot.assetId, {
      kind: 'BLOCK',
      start: isoAt(day, '10:00'),
      end: isoAt(day, '12:00'),
      unitId: a2?.id,
    });
    expect(await check(lot.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).toEqual({
      available: false,
      reason: 'BLOCKED',
    });
  });

  it('an opening adds bookable time outside the weekly schedule; a block wins over an opening', async () => {
    const saturday = nextMonday.plus({ days: 5 });
    await exception(house.host.cookie, house.assetId, {
      kind: 'OPEN',
      start: isoAt(saturday, '08:00'),
      end: isoAt(saturday, '20:00'),
    });
    expect(await check(house.assetId, isoAt(saturday, '10:00'), isoAt(saturday, '12:00'))).toEqual({
      available: true,
    });
    await exception(house.host.cookie, house.assetId, {
      kind: 'BLOCK',
      start: isoAt(saturday, '11:00'),
      end: isoAt(saturday, '11:30'),
    });
    expect(await check(house.assetId, isoAt(saturday, '10:00'), isoAt(saturday, '12:00'))).toEqual({
      available: false,
      reason: 'BLOCKED',
    });
  });

  it('removing a block restores availability; only the owner can remove it', async () => {
    const day = nextMonday.plus({ days: 2 });
    const id = (
      await exception(house.host.cookie, house.assetId, {
        kind: 'BLOCK',
        start: isoAt(day, '09:00'),
        end: isoAt(day, '19:00'),
      })
    ).json().id;
    expect((await check(house.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).available).toBe(false);
    const other = await h.hostSignUp();
    const del = (cookie: string) =>
      h.app.inject({
        method: 'DELETE',
        url: `/api/v1/host/assets/${house.assetId}/availability-exceptions/${id}`,
        headers: { ...CSRF, cookie },
      });
    expect((await del(other.cookie)).statusCode).toBe(404);
    expect((await del(house.host.cookie)).statusCode).toBe(204);
    expect((await del(house.host.cookie)).statusCode).toBe(404);
    expect(await check(house.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).toEqual({ available: true });
  });

  it('validates windows, units and ownership', async () => {
    const c = house.host.cookie;
    const id = house.assetId;
    expect(
      (
        await exception(c, id, {
          kind: 'BLOCK',
          start: isoAt(nextMonday, '12:00'),
          end: isoAt(nextMonday, '11:00'),
        })
      ).json().code,
    ).toBe('availability.invalid_window');
    const yesterday = DateTime.now().setZone(IST).minus({ days: 1 });
    expect(
      (
        await exception(c, id, {
          kind: 'BLOCK',
          start: isoAt(yesterday, '10:00'),
          end: isoAt(yesterday, '11:00'),
        })
      ).json().code,
    ).toBe('availability.invalid_window');
    const unaligned = at(nextMonday, '10:00').plus({ seconds: 30 }).toISO();
    expect(
      (await exception(c, id, { kind: 'BLOCK', start: unaligned, end: isoAt(nextMonday, '11:00') })).json()
        .code,
    ).toBe('availability.invalid_window');
    expect(
      (
        await exception(c, id, {
          kind: 'BLOCK',
          start: isoAt(nextMonday, '10:00'),
          end: at(nextMonday, '10:00').plus({ days: 400 }).toISO(),
        })
      ).json().code,
    ).toBe('availability.invalid_window');
    expect(
      (
        await exception(c, id, {
          kind: 'BLOCK',
          start: isoAt(nextMonday, '10:00'),
          end: isoAt(nextMonday, '11:00'),
          unitId: lotUnits[0]?.id,
        })
      ).json().code,
    ).toBe('availability.unknown_unit');
    const other = await h.hostSignUp();
    expect(
      (
        await exception(other.cookie, id, {
          kind: 'BLOCK',
          start: isoAt(nextMonday, '10:00'),
          end: isoAt(nextMonday, '11:00'),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('reservations (booking-based unavailability, via the ReservationSource seam)', () => {
  const houseUnit = async () =>
    (await h.get(`/api/v1/host/assets/${house.assetId}`, house.host.cookie)).json().units[0].id as string;

  it('a reservation makes overlapping windows RESERVED; adjacent windows respect the 15-min buffer', async () => {
    const unitId = await houseUnit();
    const day = nextMonday.plus({ days: 3 });
    // Existing booking 10:00–12:00 with this asset's 15-min buffer → blocked until 12:15.
    reserved.push({ unitId, start: at(day, '10:00').toMillis(), blockedUntil: at(day, '12:15').toMillis() });
    expect(await check(house.assetId, isoAt(day, '11:00'), isoAt(day, '13:00'))).toEqual({
      available: false,
      reason: 'RESERVED',
    });
    expect(await check(house.assetId, isoAt(day, '12:10'), isoAt(day, '13:00'))).toEqual({
      available: false,
      reason: 'RESERVED',
    });
    expect(await check(house.assetId, isoAt(day, '12:15'), isoAt(day, '13:15'))).toEqual({ available: true });
    expect(await check(house.assetId, isoAt(day, '09:00'), isoAt(day, '09:50'))).toEqual({
      available: false,
      reason: 'RESERVED',
    }); // own buffer
    expect(await check(house.assetId, isoAt(day, '09:00'), isoAt(day, '09:45'))).toEqual({ available: true });
  });

  it('BR-04: a host block may not overlap a reservation', async () => {
    const unitId = await houseUnit();
    const day = nextMonday.plus({ days: 4 });
    reserved.push({ unitId, start: at(day, '10:00').toMillis(), blockedUntil: at(day, '12:00').toMillis() });
    const clash = await exception(house.host.cookie, house.assetId, {
      kind: 'BLOCK',
      start: isoAt(day, '11:00'),
      end: isoAt(day, '13:00'),
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('availability.block_conflicts_booking');
    expect(
      (
        await exception(house.host.cookie, house.assetId, {
          kind: 'BLOCK',
          start: isoAt(day, '12:00'),
          end: isoAt(day, '13:00'),
        })
      ).statusCode,
    ).toBe(201);
  });

  it('on a multi-space lot a reservation takes one space; the other stays bookable', async () => {
    const day = nextMonday.plus({ days: 7 });
    reserved.push({
      unitId: lotUnits[0]?.id ?? '',
      start: at(day, '10:00').toMillis(),
      blockedUntil: at(day, '12:00').toMillis(),
    });
    expect(await check(lot.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).toEqual({ available: true });
    reserved.push({
      unitId: lotUnits[1]?.id ?? '',
      start: at(day, '10:00').toMillis(),
      blockedUntil: at(day, '12:00').toMillis(),
    });
    expect(await check(lot.assetId, isoAt(day, '10:00'), isoAt(day, '11:00'))).toEqual({
      available: false,
      reason: 'RESERVED',
    });
  });
});

describe('host calendar', () => {
  it('shows free time per space in the property timezone, with blocks (and their reasons) and reservations', async () => {
    const day = nextMonday.plus({ days: 8 }); // a Tuesday
    const unitId = (await h.get(`/api/v1/host/assets/${house.assetId}`, house.host.cookie)).json().units[0]
      .id as string;
    await exception(house.host.cookie, house.assetId, {
      kind: 'BLOCK',
      start: isoAt(day, '13:00'),
      end: isoAt(day, '14:00'),
      reason: 'Plumber',
    });
    reserved.push({ unitId, start: at(day, '10:00').toMillis(), blockedUntil: at(day, '11:15').toMillis() });
    const res = await h.get(
      `/api/v1/host/assets/${house.assetId}/calendar?from=${encodeURIComponent(isoAt(day, '00:00'))}&to=${encodeURIComponent(isoAt(day.plus({ days: 1 }), '00:00'))}`,
      house.host.cookie,
    );
    expect(res.statusCode, res.body).toBe(200);
    const cal = res.json();
    expect(cal.timezone).toBe(IST);
    const fmt = (s: string) => DateTime.fromISO(s).setZone(IST).toFormat('HH:mm');
    expect(
      cal.units[0].free.map((i: { start: string; end: string }) => `${fmt(i.start)}-${fmt(i.end)}`),
    ).toEqual(['09:00-10:00', '11:15-13:00', '14:00-19:00']);
    expect(cal.exceptions.map((e: { reason: string }) => e.reason)).toContain('Plumber');
    expect(cal.reservations).toHaveLength(1);
  });

  it('limits the range and requires ownership', async () => {
    const tooLong = await h.get(
      `/api/v1/host/assets/${house.assetId}/calendar?from=${encodeURIComponent(isoAt(nextMonday, '00:00'))}&to=${encodeURIComponent(isoAt(nextMonday.plus({ days: 70 }), '00:00'))}`,
      house.host.cookie,
    );
    expect(tooLong.json().code).toBe('availability.invalid_window');
    const other = await h.hostSignUp();
    const res = await h.get(
      `/api/v1/host/assets/${house.assetId}/calendar?from=${encodeURIComponent(isoAt(nextMonday, '00:00'))}&to=${encodeURIComponent(isoAt(nextMonday.plus({ days: 1 }), '00:00'))}`,
      other.cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('concurrency contract (block vs booking, BR-04)', () => {
  it('a host block waits for a booking transaction holding the asset row FOR SHARE', async () => {
    const day = nextMonday.plus({ days: 9 });
    const booking = await db.pool.connect();
    try {
      // Simulate the Phase 12 booking transaction's asset lock.
      await booking.query('BEGIN');
      await booking.query('SELECT 1 FROM assets.assets WHERE id = $1 FOR SHARE', [house.assetId]);
      const started = Date.now();
      const pending = exception(house.host.cookie, house.assetId, {
        kind: 'BLOCK',
        start: isoAt(day, '10:00'),
        end: isoAt(day, '11:00'),
      });
      await new Promise((r) => setTimeout(r, 700));
      await booking.query('COMMIT');
      const res = await pending;
      expect(res.statusCode).toBe(201);
      expect(Date.now() - started).toBeGreaterThanOrEqual(650); // it really waited for the lock
    } finally {
      booking.release();
    }
  });

  it('concurrent blocks on the same listing serialise without deadlock', async () => {
    const day = nextMonday.plus({ days: 10 });
    const results = await Promise.all(
      ['10:00', '11:00', '12:00', '13:00'].map((hm) =>
        exception(house.host.cookie, house.assetId, {
          kind: 'BLOCK',
          start: isoAt(day, hm),
          end: at(day, hm).plus({ minutes: 30 }).toISO(),
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
  });
});
