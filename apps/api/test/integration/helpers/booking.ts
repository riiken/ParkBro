import { DateTime } from 'luxon';
import { randomInt, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { TestDatabase } from './db.ts';
import { CSRF, randomIp, type IdentityHarness } from './identity-app.ts';
import { publishListing, type ListingSpec } from './publish.ts';

export const IST = 'Asia/Kolkata';
const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
export const randomPlate = () =>
  `KA${String(randomInt(1, 70)).padStart(2, '0')}${letters[randomInt(0, letters.length)]}${letters[randomInt(0, letters.length)]}${String(randomInt(1000, 10000))}`;

/** Customer and booking helpers over the real API (shared by booking-related integration tests). */
export function bookingKit(h: IdentityHarness, admin: () => string, db: TestDatabase) {
  async function customer(vehicle: { vehicleClass?: string; isEv?: boolean; connectors?: string[] } = {}) {
    const user = await h.signUp(undefined, 'Priya Sharma');
    const res = await h.post(
      '/api/v1/me/vehicles',
      {
        plate: randomPlate(),
        vehicleClass: vehicle.vehicleClass ?? 'HATCHBACK',
        isEv: vehicle.isEv ?? false,
        connectors: vehicle.connectors ?? [],
      },
      { cookie: user.cookie },
    );
    expect(res.statusCode, res.body).toBe(201);
    return { ...user, vehicleId: res.json().id as string };
  }
  type Customer = Awaited<ReturnType<typeof customer>>;

  const quote = (c: Customer, assetId: string, start: string, end: string, mode = 'HOURLY') =>
    h.post('/api/v1/quotes', { assetId, mode, start, end }, { cookie: c.cookie });

  async function quoteId(c: Customer, assetId: string, start: string, end: string, mode = 'HOURLY') {
    const res = await quote(c, assetId, start, end, mode);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().quoteId as string;
  }

  const book = (c: Customer, qid: string, key: string = randomUUID()) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { ...CSRF, cookie: c.cookie, 'idempotency-key': key },
      payload: { quoteId: qid, vehicleId: c.vehicleId },
      remoteAddress: randomIp(),
    });

  async function booked(c: Customer, assetId: string, start: string, end: string, mode = 'HOURLY') {
    const res = await book(c, await quoteId(c, assetId, start, end, mode));
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; status: string; series: { id: string; periodIndex: number } | null };
  }

  const listing = (seed: number, spec: Partial<ListingSpec> = {}) =>
    publishListing(h, admin(), {
      seed,
      latitude: 12.9352,
      longitude: 77.6245,
      title: `Series test spot ${'abcdefghijklmnop'[seed % 16]}`,
      ...spec,
    });

  const sql = (text: string, params: unknown[] = []) => db.pool.query(text, params);

  return { customer, quote, quoteId, book, booked, listing, sql };
}

export const istDay = (daysAhead: number) =>
  DateTime.now().setZone(IST).plus({ days: daysAhead }).startOf('day');
export const at = (d: DateTime, hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return d.set({ hour: hh ?? 0, minute: mm ?? 0 }).toISO() ?? '';
};
