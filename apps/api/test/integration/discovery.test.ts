import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, randomIp, type IdentityHarness } from './helpers/identity-app.ts';
import { publishListing } from './helpers/publish.ts';

let db: TestDatabase;
let h: IdentityHarness;
let admin: string;

// Deterministic fuzzing: offset = range minimum, bearing north (residential +200 m north, commercial +0 m).
const O = { latitude: 12.9352, longitude: 77.6245 };
const north = (m: number) => ({ latitude: O.latitude + m / 111_195, longitude: O.longitude });
const east = (m: number) => ({
  latitude: O.latitude,
  longitude: O.longitude + m / (111_195 * Math.cos((O.latitude * Math.PI) / 180)),
});

const ids: Record<string, string> = {};
const secrets = { address: '77 SECRETLANE, Koramangala', access: 'SECRETACCESS gate code 4321' };

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {}, { random: () => 0 });
  admin = await h.adminSignIn(['TRUST_SAFETY']);

  const weekdays9to7 = [{ weekdays: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '19:00' }];
  const l1 = await publishListing(h, admin, {
    seed: 1,
    ...O,
    address: secrets.address,
    accessInstructions: secrets.access,
    title: 'Covered gated driveway',
    parking: { covered: true, security: ['CCTV', 'GATED'], maxVehicleClass: 'SEDAN' },
    rates: [
      { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
      { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
    ],
    rules: weekdays9to7,
    extraPhotos: [{ kind: 'ENTRANCE', seed: 901 }],
  });
  ids.l1 = l1.assetId;
  ids.l1Property = l1.propertyId;
  ids.l1HostAccount = l1.host.hostAccountId;

  ids.l2 = (
    await publishListing(h, admin, {
      seed: 2,
      kind: 'COMMERCIAL',
      ...east(1000),
      title: 'Shop lot with guard',
      parking: { covered: false, security: ['GUARD'], maxVehicleClass: 'SUV' },
      rates: [
        { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 2500 },
        { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 15000 },
      ],
      units: ['A1', 'A2', 'A3'],
      asset: { leadMinutes: 1440 },
    })
  ).assetId;
  ids.l3 = (
    await publishListing(h, admin, {
      seed: 3,
      ...north(2000),
      title: 'Covered EV ready basement',
      parking: { covered: true, evReadySocket: true, maxVehicleClass: 'MUV' },
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 6000 }],
    })
  ).assetId;
  ids.l4 = (
    await publishListing(h, admin, { seed: 4, type: 'EV_CHARGING', ...north(-500), title: 'Home AC charger' })
  ).assetId;
  ids.l5 = (
    await publishListing(h, admin, {
      seed: 5,
      type: 'EV_CHARGING',
      kind: 'COMMERCIAL',
      ...east(-1500),
      title: 'Fast DC charger at cafe',
      charger: { connectors: ['CCS2'], currentType: 'DC', powerKw: 30, connectionType: 'COMMERCIAL' },
      rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_SESSION', pricePaise: 50000 }],
    })
  ).assetId;
  ids.far = (
    await publishListing(h, admin, { seed: 6, ...north(8_000), title: 'Far away driveway' })
  ).assetId;
  ids.draft = (
    await publishListing(h, admin, { seed: 7, ...O, title: 'Unpublished draft spot', publish: false })
  ).assetId;
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

type Result = { id: string; distanceM: number; price: { mode: string; pricePaise: number } };
async function search(params: Record<string, string | number | boolean>, ip = randomIp()) {
  const query = new URLSearchParams({
    lat: String(O.latitude),
    lng: String(O.longitude),
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  return h.app.inject({ method: 'GET', url: `/api/v1/listings/search?${query}`, remoteAddress: ip });
}
async function ids_(params: Record<string, string | number | boolean>) {
  const res = await search(params);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().results as Result[]).map((r) => r.id);
}

describe('search: visibility, radius and distance', () => {
  it('returns only published listings of the type within the radius, nearest first, with rounded distances', async () => {
    const res = await search({ type: 'PARKING' });
    const results = res.json().results as Result[];
    expect(results.map((r) => r.id)).toEqual([ids.l1, ids.l2, ids.l3]);
    // Distances come from the fuzzed public point (L-2): the house at O is reported ~200 m away, not 0.
    expect(results.map((r) => r.distanceM)).toEqual([200, 1000, 2200]);
    expect(results.every((r) => r.distanceM % 100 === 0)).toBe(true);
    expect(await ids_({ type: 'PARKING', radiusM: 10_000 })).toContain(ids.far);
  });

  it('paused, suspended and restricted-host listings disappear from search and detail', async () => {
    const extra = await publishListing(h, admin, { seed: 8, ...east(300), title: 'Soon paused listing' });
    expect(await ids_({ type: 'PARKING' })).toContain(extra.assetId);

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/assets/${extra.assetId}/pause`,
      headers: { ...CSRF, cookie: extra.host.cookie },
    });
    expect(await ids_({ type: 'PARKING' })).not.toContain(extra.assetId);
    expect((await h.get(`/api/v1/listings/${extra.assetId}`)).statusCode).toBe(404);

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/host/assets/${extra.assetId}/republish`,
      headers: { ...CSRF, cookie: extra.host.cookie },
    });
    expect(await ids_({ type: 'PARKING' })).toContain(extra.assetId);
    await db.pool.query(`UPDATE identity.host_accounts SET status = 'RESTRICTED' WHERE id = $1`, [
      extra.host.hostAccountId,
    ]);
    expect(await ids_({ type: 'PARKING' })).not.toContain(extra.assetId);
    await db.pool.query(`UPDATE identity.host_accounts SET status = 'ACTIVE' WHERE id = $1`, [
      extra.host.hostAccountId,
    ]);

    await h.app.inject({
      method: 'POST',
      url: `/api/admin/assets/${extra.assetId}/suspend`,
      headers: { ...CSRF, cookie: admin },
      payload: { reason: 'Test suspension' },
    });
    expect(await ids_({ type: 'PARKING' })).not.toContain(extra.assetId);
    expect(await ids_({ type: 'PARKING', radiusM: 10_000 })).not.toContain(ids.draft);
  });
});

describe('search: filters and sorting', () => {
  it('parking filters', async () => {
    expect(await ids_({ type: 'PARKING', covered: true })).toEqual([ids.l1, ids.l3]);
    expect(await ids_({ type: 'PARKING', security: 'CCTV,GATED' })).toEqual([ids.l1]);
    expect(await ids_({ type: 'PARKING', evReady: true })).toEqual([ids.l3]);
    expect(await ids_({ type: 'PARKING', vehicleClass: 'SUV' })).toEqual([ids.l2, ids.l3]);
  });

  it('booking mode selects the price shown and filters listings without that mode', async () => {
    const monthly = (await search({ type: 'PARKING', mode: 'MONTHLY' })).json().results as Result[];
    expect(monthly.map((r) => [r.id, r.price.mode, r.price.pricePaise])).toEqual([
      [ids.l1, 'MONTHLY', 300000],
    ]);
    expect(await ids_({ type: 'PARKING', mode: 'HOURLY', maxPricePaise: 4000 })).toEqual([ids.l1, ids.l2]);
  });

  it('sorts by price (requires a mode)', async () => {
    expect(await ids_({ type: 'PARKING', mode: 'HOURLY', sort: 'price' })).toEqual([ids.l2, ids.l1, ids.l3]);
    expect((await search({ type: 'PARKING', sort: 'price' })).statusCode).toBe(400);
  });

  it('EV filters', async () => {
    expect(await ids_({ type: 'EV_CHARGING' })).toEqual([ids.l4, ids.l5]);
    expect(await ids_({ type: 'EV_CHARGING', connectors: 'CCS2' })).toEqual([ids.l5]);
    expect(await ids_({ type: 'EV_CHARGING', currentType: 'AC' })).toEqual([ids.l4]);
    expect(await ids_({ type: 'EV_CHARGING', minPowerKw: 20 })).toEqual([ids.l5]);
    const ev = (await search({ type: 'EV_CHARGING' })).json().results as { charger: object }[];
    expect(ev[1]?.charger).toEqual({ connectors: ['CCS2'], currentType: 'DC', powerKw: 30 });
  });

  it('rejects inconsistent queries', async () => {
    expect((await search({ type: 'PARKING', connectors: 'TYPE2' })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', mode: 'CHARGING_SESSION' })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', maxPricePaise: 5000 })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', radiusM: 50_000 })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', security: 'LASERS' })).statusCode).toBe(400);
  });
});

describe('search: pagination', () => {
  it('walks all results exactly once, in order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await search({ type: 'PARKING', limit: 1, ...(cursor ? { cursor } : {}) });
      const body = res.json() as { results: Result[]; nextCursor: string | null };
      seen.push(...body.results.map((r) => r.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([ids.l1, ids.l2, ids.l3]);
  });

  it('rejects tampered cursors and cursors from a different search', async () => {
    const first = (await search({ type: 'PARKING', limit: 1 })).json().nextCursor as string;
    expect((await search({ type: 'PARKING', limit: 1, covered: true, cursor: first })).json().code).toBe(
      'discovery.invalid_cursor',
    );
    expect((await search({ type: 'PARKING', limit: 1, cursor: `${first}x` })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', limit: 1, cursor: 'not-a-cursor' })).statusCode).toBe(400);
  });
});

describe('search: coarse availability (weekly rules, property timezone)', () => {
  const nextMonday = DateTime.now().setZone('Asia/Kolkata').plus({ weeks: 1 }).startOf('week'); // ISO week starts Monday
  const window = (day: DateTime, from: string, to: string) => {
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    return {
      start: day.set({ hour: fh, minute: fm }).toISO() ?? '',
      end: day.set({ hour: th, minute: tm }).toISO() ?? '',
    };
  };

  it('includes listings whose rules cover the window and excludes those that do not', async () => {
    expect(await ids_({ type: 'PARKING', ...window(nextMonday, '10:00', '12:00') })).toEqual([
      ids.l1,
      ids.l2,
      ids.l3,
    ]);
    const saturday = nextMonday.plus({ days: 5 });
    expect(await ids_({ type: 'PARKING', ...window(saturday, '10:00', '12:00') })).toEqual([ids.l2, ids.l3]);
    expect(await ids_({ type: 'PARKING', ...window(nextMonday, '18:00', '20:00') })).toEqual([
      ids.l2,
      ids.l3,
    ]);
  });

  it('applies duration limits for hourly bookings and the host lead time', async () => {
    expect(await ids_({ type: 'PARKING', mode: 'HOURLY', ...window(nextMonday, '10:00', '10:30') })).toEqual(
      [],
    ); // below 60-min minimum
    const soon = DateTime.now().setZone('Asia/Kolkata').plus({ hours: 2 }).startOf('hour');
    const soonWindow = { start: soon.toISO() ?? '', end: soon.plus({ hours: 1 }).toISO() ?? '' };
    expect(await ids_({ type: 'PARKING', ...soonWindow })).not.toContain(ids.l2); // 24 h lead time
  });

  it('a monthly window must be covered continuously', async () => {
    const month = {
      start: nextMonday.set({ hour: 0 }).toISO() ?? '',
      end: nextMonday.plus({ months: 1 }).set({ hour: 0 }).toISO() ?? '',
    };
    expect(await ids_({ type: 'PARKING', mode: 'MONTHLY', ...month })).toEqual([]); // L1 is weekdays 9–7 only
    expect(await ids_({ type: 'PARKING', ...month })).toEqual([ids.l2, ids.l3]); // all-day, every day
  });

  it('validates windows', async () => {
    const w = window(nextMonday, '12:00', '10:00');
    expect((await search({ type: 'PARKING', ...w })).statusCode).toBe(400);
    expect((await search({ type: 'PARKING', start: w.start })).statusCode).toBe(400);
  });
});

describe('listing detail (public view)', () => {
  it('residential: area precision, no space count, first name only, public photos only, weekly schedule', async () => {
    const res = await h.get(`/api/v1/listings/${ids.l1}`);
    expect(res.statusCode).toBe(200);
    const l = res.json();
    expect(l.location).toMatchObject({ precision: 'AREA', radiusM: 500 });
    expect(l.spaces).toBeNull();
    expect(l.host.name).toBe('Host'); // "Host 1" → first name only (L-8)
    expect(l.photos.map((p: { kind: string }) => p.kind)).toEqual(['SLOT']); // entrance photo excluded
    expect(l.rates.map((r: { mode: string }) => r.mode)).toEqual(['HOURLY', 'MONTHLY']);
    expect(l.schedule).toEqual([{ weekdays: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '19:00' }]);
    expect(l.distanceM).toBeNull();
    const withDistance = (
      await h.get(`/api/v1/listings/${ids.l1}?lat=${O.latitude}&lng=${O.longitude}`)
    ).json();
    expect(withDistance.distanceM).toBe(200);
  });

  it('commercial: pin precision and space count', async () => {
    const l = (await h.get(`/api/v1/listings/${ids.l2}`)).json();
    expect(l.location).toMatchObject({ precision: 'PIN', radiusM: 0 });
    expect(l.spaces).toBe(3);
  });

  it('unknown or unpublished listings are 404', async () => {
    expect((await h.get(`/api/v1/listings/${ids.draft}`)).statusCode).toBe(404);
    expect((await h.get('/api/v1/listings/01a1568b-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('L-9: no public endpoint leaks private location or access data', () => {
  it('search and detail responses never contain the exact point, address, access instructions or internal ids', async () => {
    const bodies = [
      (await search({ type: 'PARKING' })).body,
      (await search({ type: 'PARKING', mode: 'MONTHLY' })).body,
      (await h.get(`/api/v1/listings/${ids.l1}`)).body,
      (await h.get(`/api/v1/listings/${ids.l1}?lat=${O.latitude}&lng=${O.longitude}`)).body,
    ];
    const exactPoint = await db.pool.query(
      'SELECT ST_Y(public_point::geometry) AS lat FROM properties.properties WHERE id = $1',
      [ids.l1Property],
    );
    expect(Math.abs(exactPoint.rows[0].lat - O.latitude)).toBeGreaterThan(0.001); // public point really differs

    for (const body of bodies) {
      expect(body).not.toContain('SECRET');
      expect(body).not.toContain('4321');
      expect(body).not.toContain(String(O.latitude)); // exact latitude 12.9352
      expect(body).not.toContain(String(O.longitude)); // exact longitude 77.6245
      expect(body).not.toContain(ids.l1Property);
      expect(body).not.toContain(ids.l1HostAccount);
    }
  });

  it('the public listing has exactly the documented fields (no accidental additions)', async () => {
    const l = (await h.get(`/api/v1/listings/${ids.l1}`)).json();
    expect(Object.keys(l).sort()).toEqual(
      [
        'booking',
        'charger',
        'description',
        'distanceM',
        'host',
        'id',
        'location',
        'parking',
        'photos',
        'rates',
        'rulesText',
        'schedule',
        'societyName',
        'spaces',
        'timezone',
        'title',
        'type',
        'areaLabel',
      ].sort(),
    );
    expect(Object.keys(l.location).sort()).toEqual(['latitude', 'longitude', 'precision', 'radiusM']);
    expect(String(l.location.latitude).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3); // ~110 m precision
    expect(Object.keys(l.host).sort()).toEqual(['name', 'since']);
  });

  it('the discovery views physically lack private columns', async () => {
    const cols = await db.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'discovery'`,
    );
    const names = cols.rows.map((r) => r.column_name as string);
    for (const forbidden of [
      'exact_address_enc',
      'exact_point_enc',
      'access_instructions_enc',
      'storage_key',
      'owner_host_account_id',
      'host_account_id',
      'property_id',
      'phone_enc',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('rate limiting, places and query plans', () => {
  it('limits searches per IP (60 per minute)', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await search({ type: 'EV_CHARGING' }, ip)).statusCode);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('place autocomplete and details (fixture geocoder)', async () => {
    const predictions = (await h.get('/api/v1/places/autocomplete?q=kora')).json();
    expect(predictions[0]).toMatchObject({ placeId: 'fixture:koramangala', primaryText: 'Koramangala' });
    expect((await h.get('/api/v1/places/fixture:koramangala')).json()).toMatchObject({
      latitude: 12.9352,
      longitude: 77.6245,
    });
    expect((await h.get('/api/v1/places/fixture:atlantis')).statusCode).toBe(404);
    expect((await h.get('/api/v1/places/autocomplete?q=k')).statusCode).toBe(400);
  });

  it('the radius predicate over the discovery view can use the GiST index on public points', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN SELECT id FROM discovery.published_listings l
          WHERE ST_DWithin(l.public_point, ST_SetSRID(ST_MakePoint(77.6245, 12.9352), 4326)::geography, 3000)`,
      );
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('properties_public_point_gix');
    } finally {
      client.release();
    }
  });
});
