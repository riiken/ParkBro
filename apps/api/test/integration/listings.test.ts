import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haversineMeters } from '../../src/modules/properties/index.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { CSRF, identityHarness, type IdentityHarness } from './helpers/identity-app.ts';
import { jpegWithGps, png } from './helpers/images.ts';

let db: TestDatabase;
let h: IdentityHarness;
let trustAdmin: string;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db);
  trustAdmin = await h.adminSignIn(['TRUST_SAFETY']);
});
afterAll(async () => {
  await h.close();
  await db.drop();
});

// ------------------------------------------------------------------ helpers

const BLR = { latitude: 12.9352, longitude: 77.6245 };

const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
  h.app.inject({ method, url, headers: { ...CSRF, cookie }, ...(payload ? { payload } : {}) });

async function createProperty(cookie: string, overrides: object = {}) {
  const res = await send('POST', '/api/v1/host/properties', cookie, {
    kind: 'INDEPENDENT_HOUSE',
    address: '12, 5th Cross, Koramangala, Bengaluru 560034',
    ...BLR,
    areaLabel: 'Koramangala',
    ...overrides,
  });
  return res;
}

async function createAsset(
  cookie: string,
  propertyId: string,
  type: 'PARKING' | 'EV_CHARGING' = 'PARKING',
  extra: object = {},
) {
  return send('POST', '/api/v1/host/assets', cookie, {
    propertyId,
    type,
    title: type === 'PARKING' ? 'Covered driveway near Forum Mall' : 'Home AC charger with parking',
    description: 'Gated driveway, fits a sedan.',
    accessInstructions: 'Ring the bell at the blue gate; call 98765 43210 if no answer.',
    ...extra,
  });
}

async function uploadPhoto(
  cookie: string,
  assetId: string,
  kind: string,
  body: Buffer,
  query = '',
  contentType = 'image/jpeg',
) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/host/assets/${assetId}/media?kind=${kind}${query}`,
    headers: { ...CSRF, cookie, 'content-type': contentType },
    payload: body,
  });
}

async function makeReady(
  cookie: string,
  assetId: string,
  type: 'PARKING' | 'EV_CHARGING' = 'PARKING',
  seed = 1,
) {
  await send('PUT', `/api/v1/host/assets/${assetId}/parking-details`, cookie, {
    covered: true,
    level: 'GROUND',
    maxVehicleClass: 'SEDAN',
    security: ['GATED', 'CCTV'],
  });
  if (type === 'EV_CHARGING') {
    await send('PUT', `/api/v1/host/assets/${assetId}/charger-details`, cookie, {
      connectors: ['TYPE2'],
      currentType: 'AC',
      powerKw: 7.4,
      cableProvided: true,
      connectionType: 'EV_METERED',
    });
    await uploadPhoto(cookie, assetId, 'CHARGER', await png(800, 600, seed + 100), '', 'image/png');
    await send('POST', `/api/v1/host/assets/${assetId}/attestations`, cookie, {
      kind: 'CHARGER_SAFETY',
      accepted: true,
    });
  }
  await send('PUT', `/api/v1/host/assets/${assetId}/rates`, cookie, {
    rates:
      type === 'PARKING'
        ? [
            { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
            { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
          ]
        : [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 12000 }],
  });
  await send('PUT', `/api/v1/host/assets/${assetId}/availability-rules`, cookie, {
    rules: [{ weekdays: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '19:00' }],
  });
  await send('POST', `/api/v1/host/assets/${assetId}/attestations`, cookie, {
    kind: 'RIGHT_TO_RENT',
    accepted: true,
  });
  const photo = await uploadPhoto(cookie, assetId, 'SLOT', await jpegWithGps({ seed }));
  return photo.json();
}

async function publishedParking(seed: number) {
  const host = await h.hostSignUp();
  const property = (await createProperty(host.cookie)).json();
  const asset = (await createAsset(host.cookie, property.id)).json();
  await makeReady(host.cookie, asset.id, 'PARKING', seed);
  await send('POST', `/api/v1/host/assets/${asset.id}/submit`, host.cookie);
  const approved = await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, {});
  expect(approved.json().status).toBe('PUBLISHED');
  return { host, property, asset: (await h.get(`/api/v1/host/assets/${asset.id}`, host.cookie)).json() };
}

// ------------------------------------------------------------------ host accounts

describe('host accounts', () => {
  it('becoming a host grants the HOST role, once', async () => {
    const user = await h.signUp();
    const first = await send('POST', '/api/v1/host/account', user.cookie, { displayName: 'Ravi K' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ role: 'OWNER', status: 'ACTIVE', kind: 'INDIVIDUAL' });
    expect((await h.get('/api/v1/me', user.cookie)).json().roles).toEqual(['CUSTOMER', 'HOST']);
    expect(
      (await send('POST', '/api/v1/host/account', user.cookie, { displayName: 'Again' })).json().code,
    ).toBe('host.already_host');
  });

  it('non-hosts cannot create properties or listings', async () => {
    const user = await h.signUp();
    const res = await createProperty(user.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('host.not_a_host');
  });

  it('restricted hosts keep read access but cannot change anything', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    await db.pool.query(`UPDATE identity.host_accounts SET status = 'RESTRICTED' WHERE id = $1`, [
      host.hostAccountId,
    ]);
    expect((await h.get('/api/v1/host/properties', host.cookie)).statusCode).toBe(200);
    expect((await createAsset(host.cookie, property.id)).json().code).toBe('host.restricted');
  });
});

// ------------------------------------------------------------------ properties

describe('properties and location privacy', () => {
  it('stores the exact address and point encrypted and publishes only a stable fuzzed point (200–500 m)', async () => {
    const host = await h.hostSignUp();
    const res = await createProperty(host.cookie);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    const offset = haversineMeters(p.exactPoint, p.publicPoint);
    expect(offset).toBeGreaterThanOrEqual(199);
    expect(offset).toBeLessThanOrEqual(501);

    const raw = await db.pool.query(
      'SELECT exact_address_enc, exact_point_enc FROM properties.properties WHERE id = $1',
      [p.id],
    );
    const row = raw.rows[0] as { exact_address_enc: Buffer; exact_point_enc: Buffer };
    expect(row.exact_address_enc.includes(Buffer.from('Koramangala'))).toBe(false);
    expect(row.exact_point_enc.includes(Buffer.from('12.935'))).toBe(false);

    // Stable: reading again (or editing non-location fields) never re-draws the offset.
    const relabelled = await send('PATCH', `/api/v1/host/properties/${p.id}`, host.cookie, {
      version: p.version,
      areaLabel: 'Koramangala 5th Block',
    });
    expect(relabelled.json().publicPoint).toEqual(p.publicPoint);
  });

  it('commercial properties use a small offset (0–100 m)', async () => {
    const host = await h.hostSignUp();
    const p = (await createProperty(host.cookie, { kind: 'COMMERCIAL' })).json();
    expect(haversineMeters(p.exactPoint, p.publicPoint)).toBeLessThanOrEqual(101);
  });

  it('validates service area, locality labels and kind', async () => {
    const host = await h.hostSignUp();
    expect((await createProperty(host.cookie, { latitude: 51.5, longitude: -0.12 })).json().code).toBe(
      'property.outside_service_area',
    );
    expect((await createProperty(host.cookie, { areaLabel: 'Flat 402, Tower B' })).statusCode).toBe(400);
    expect((await createProperty(host.cookie, { areaLabel: 'call 9876543210' })).statusCode).toBe(400);
    expect((await createProperty(host.cookie, { kind: 'APARTMENT_SOCIETY' })).statusCode).toBe(400);
    expect((await createProperty(host.cookie, { timezone: 'Mars/Olympus' })).json().code).toBe(
      'property.invalid_timezone',
    );
  });

  it("other hosts can't see or edit someone's property", async () => {
    const owner = await h.hostSignUp();
    const p = (await createProperty(owner.cookie)).json();
    const other = await h.hostSignUp();
    expect((await h.get(`/api/v1/host/properties/${p.id}`, other.cookie)).statusCode).toBe(404);
    expect(
      (
        await send('PATCH', `/api/v1/host/properties/${p.id}`, other.cookie, {
          version: 1,
          areaLabel: 'Hijacked',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects stale edits (optimistic concurrency) and redraws the offset when the location changes', async () => {
    const host = await h.hostSignUp();
    const p = (await createProperty(host.cookie)).json();
    const moved = await send('PATCH', `/api/v1/host/properties/${p.id}`, host.cookie, {
      version: p.version,
      latitude: 12.97,
      longitude: 77.64,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().publicPoint).not.toEqual(p.publicPoint);
    const stale = await send('PATCH', `/api/v1/host/properties/${p.id}`, host.cookie, {
      version: p.version,
      areaLabel: 'Indiranagar',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('conflict.stale');
  });
});

// ------------------------------------------------------------------ listings

describe('listing creation and editing', () => {
  it('creates a draft with one default space and a checklist of what is missing', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    const res = await createAsset(host.cookie, property.id);
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({
      status: 'DRAFT',
      type: 'PARKING',
      units: [{ label: 'Space 1', status: 'ACTIVE' }],
    });
    expect(a.checklist).toEqual({
      ready: false,
      missing: ['PARKING_DETAILS', 'PHOTO_SLOT', 'RATE', 'AVAILABILITY', 'ATTESTATION_RIGHT_TO_RENT'],
    });
    // Access instructions are encrypted at rest and may contain contact details (private until booking).
    const raw = await db.pool.query('SELECT access_instructions_enc FROM assets.assets WHERE id = $1', [
      a.id,
    ]);
    expect((raw.rows[0].access_instructions_enc as Buffer).includes(Buffer.from('blue gate'))).toBe(false);
    expect(a.accessInstructions).toContain('blue gate');
  });

  it('blocks contact details in public text', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    const res = await createAsset(host.cookie, property.id, 'PARKING', {
      title: 'Parking, WhatsApp 9876543210',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].message).toMatch(/Customers contact you through ParkBro/);
  });

  it("can't list at someone else's property", async () => {
    const owner = await h.hostSignUp();
    const property = (await createProperty(owner.cookie)).json();
    const other = await h.hostSignUp();
    expect((await createAsset(other.cookie, property.id)).json().code).toBe('asset.property_unavailable');
  });

  it("other hosts can't read or change a listing", async () => {
    const owner = await h.hostSignUp();
    const asset = (await createAsset(owner.cookie, (await createProperty(owner.cookie)).json().id)).json();
    const other = await h.hostSignUp();
    expect((await h.get(`/api/v1/host/assets/${asset.id}`, other.cookie)).statusCode).toBe(404);
    expect(
      (
        await send('PATCH', `/api/v1/host/assets/${asset.id}`, other.cookie, {
          version: asset.version,
          title: 'Mine now!',
        })
      ).statusCode,
    ).toBe(404);
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/submit`, other.cookie)).statusCode).toBe(404);
  });

  it('enforces optimistic concurrency on edits', async () => {
    const host = await h.hostSignUp();
    const asset = (await createAsset(host.cookie, (await createProperty(host.cookie)).json().id)).json();
    const ok = await send('PATCH', `/api/v1/host/assets/${asset.id}`, host.cookie, {
      version: asset.version,
      bufferMinutes: 15,
    });
    expect(ok.json().bufferMinutes).toBe(15);
    expect(
      (
        await send('PATCH', `/api/v1/host/assets/${asset.id}`, host.cookie, {
          version: asset.version,
          bufferMinutes: 30,
        })
      ).json().code,
    ).toBe('conflict.stale');
  });

  it('validates rates by listing type and keeps rate history', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    const parking = (await createAsset(host.cookie, property.id)).json();
    const ev = (await createAsset(host.cookie, property.id, 'EV_CHARGING')).json();
    const rates = (assetId: string, r: object[]) =>
      send('PUT', `/api/v1/host/assets/${assetId}/rates`, host.cookie, { rates: r });

    expect((await rates(ev.id, [{ mode: 'DAILY', unit: 'PER_DAY', pricePaise: 50000 }])).json().code).toBe(
      'asset.wrong_type',
    );
    expect(
      (await rates(parking.id, [{ mode: 'HOURLY', unit: 'PER_DAY', pricePaise: 5000 }])).json().code,
    ).toBe('asset.wrong_type');
    expect(
      (await rates(parking.id, [{ mode: 'OVERNIGHT', unit: 'PER_NIGHT', pricePaise: 15000 }])).statusCode,
    ).toBe(400);
    expect(
      (
        await rates(parking.id, [
          { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
          { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 5000 },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await rates(parking.id, [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 50 }])).statusCode).toBe(
      400,
    );

    const overnight = await rates(parking.id, [
      {
        mode: 'OVERNIGHT',
        unit: 'PER_NIGHT',
        pricePaise: 15000,
        overnightStart: '20:00',
        overnightEnd: '08:00',
      },
    ]);
    expect(overnight.json().rates).toEqual([
      {
        mode: 'OVERNIGHT',
        unit: 'PER_NIGHT',
        pricePaise: 15000,
        overnightStart: '20:00',
        overnightEnd: '08:00',
      },
    ]);
    await rates(parking.id, [
      {
        mode: 'OVERNIGHT',
        unit: 'PER_NIGHT',
        pricePaise: 18000,
        overnightStart: '20:00',
        overnightEnd: '08:00',
      },
    ]);
    const history = await db.pool.query(
      'SELECT count(*)::int AS n, count(*) FILTER (WHERE retired_at IS NULL)::int AS live FROM pricing.rates WHERE asset_id = $1',
      [parking.id],
    );
    expect(history.rows[0]).toEqual({ n: 2, live: 1 });

    expect(
      (await rates(ev.id, [{ mode: 'CHARGING_SESSION', unit: 'PER_SESSION', pricePaise: 25000 }])).statusCode,
    ).toBe(200);
  });

  it('validates availability rules', async () => {
    const host = await h.hostSignUp();
    const asset = (await createAsset(host.cookie, (await createProperty(host.cookie)).json().id)).json();
    const rules = (r: object[]) =>
      send('PUT', `/api/v1/host/assets/${asset.id}/availability-rules`, host.cookie, { rules: r });
    expect((await rules([{ weekdays: [8], startLocal: '09:00', endLocal: '17:00' }])).statusCode).toBe(400);
    expect((await rules([{ weekdays: [1], startLocal: '9am', endLocal: '17:00' }])).statusCode).toBe(400);
    expect(
      (
        await rules(
          Array.from({ length: 15 }, () => ({ weekdays: [1], startLocal: '09:00', endLocal: '17:00' })),
        )
      ).statusCode,
    ).toBe(400);
    const overnight = await rules([{ weekdays: [5, 6, 5], startLocal: '19:00', endLocal: '09:00' }]);
    expect(overnight.json().availabilityRules).toMatchObject([
      { weekdays: [5, 6], startLocal: '19:00', endLocal: '09:00' },
    ]);
    // Regression (Phase 10): DATE columns come back as plain YYYY-MM-DD, not a stringified JS Date.
    expect(overnight.json().availabilityRules[0].validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('manages spaces: new labels added, removed ones deactivated (never deleted)', async () => {
    const host = await h.hostSignUp();
    const asset = (
      await createAsset(host.cookie, (await createProperty(host.cookie, { kind: 'COMMERCIAL' })).json().id)
    ).json();
    const res = await send('PUT', `/api/v1/host/assets/${asset.id}/units`, host.cookie, {
      labels: ['A1', 'A2'],
    });
    expect(
      res
        .json()
        .units.map((u: { label: string; status: string }) => `${u.label}:${u.status}`)
        .sort(),
    ).toEqual(['A1:ACTIVE', 'A2:ACTIVE', 'Space 1:INACTIVE']);
    expect(
      (await send('PUT', `/api/v1/host/assets/${asset.id}/units`, host.cookie, { labels: ['A1', 'A1'] }))
        .statusCode,
    ).toBe(400);
  });

  it('EV listings need charger details, a charger photo and a safety attestation; parking listings reject them', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    const ev = (await createAsset(host.cookie, property.id, 'EV_CHARGING')).json();
    expect(ev.checklist.missing).toEqual(
      expect.arrayContaining(['CHARGER_DETAILS', 'PHOTO_CHARGER', 'ATTESTATION_CHARGER_SAFETY']),
    );
    const parking = (await createAsset(host.cookie, property.id)).json();
    const charger = {
      connectors: ['TYPE2'],
      currentType: 'AC',
      powerKw: 7.4,
      cableProvided: true,
      connectionType: 'DOMESTIC',
    };
    expect(
      (await send('PUT', `/api/v1/host/assets/${parking.id}/charger-details`, host.cookie, charger)).json()
        .code,
    ).toBe('asset.wrong_type');
    expect(
      (
        await send('POST', `/api/v1/host/assets/${parking.id}/attestations`, host.cookie, {
          kind: 'CHARGER_SAFETY',
          accepted: true,
        })
      ).json().code,
    ).toBe('asset.wrong_type');
    expect(
      (
        await send('PUT', `/api/v1/host/assets/${ev.id}/parking-details`, host.cookie, {
          covered: true,
          level: 'GROUND',
          maxVehicleClass: 'SUV',
          evReadySocket: true,
        })
      ).json().code,
    ).toBe('asset.wrong_type');
    const ready = await makeReady(host.cookie, ev.id, 'EV_CHARGING', 7);
    expect(ready.checklist).toEqual({ ready: true, missing: [] });
  });
});

describe('photos', () => {
  it('strips EXIF/GPS, stores WebP privately and records the capture distance', async () => {
    const host = await h.hostSignUp();
    const property = (await createProperty(host.cookie)).json();
    const asset = (await createAsset(host.cookie, property.id)).json();
    const res = await uploadPhoto(
      host.cookie,
      asset.id,
      'SLOT',
      await jpegWithGps({ seed: 11 }),
      `&lat=${BLR.latitude + 0.0009}&lng=${BLR.longitude}`,
    );
    expect(res.statusCode).toBe(201);
    const media = res.json().media[0];
    expect(media).toMatchObject({
      kind: 'SLOT',
      moderationStatus: 'PENDING',
      url: `/api/v1/media/${media.id}`,
    });

    const stored = [...h.storage.objects.entries()].find(([key]) => key.includes(media.id));
    expect(stored).toBeDefined();
    const meta = await sharp(stored?.[1]).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    const row = await db.pool.query('SELECT capture_distance_m FROM assets.asset_media WHERE id = $1', [
      media.id,
    ]);
    expect(row.rows[0].capture_distance_m).toBeGreaterThan(80);
    expect(row.rows[0].capture_distance_m).toBeLessThan(120);
  });

  it('rejects non-images, oversized bodies, tiny images and an 11th photo', async () => {
    const host = await h.hostSignUp();
    const asset = (await createAsset(host.cookie, (await createProperty(host.cookie)).json().id)).json();
    expect((await uploadPhoto(host.cookie, asset.id, 'SLOT', Buffer.from('not an image'))).json().code).toBe(
      'media.unsupported',
    );
    expect(
      (await uploadPhoto(host.cookie, asset.id, 'SLOT', Buffer.from('<svg/>'), '', 'image/svg+xml'))
        .statusCode,
    ).toBe(415);
    expect(
      (await uploadPhoto(host.cookie, asset.id, 'SLOT', Buffer.alloc(11 * 1024 * 1024, 1))).statusCode,
    ).toBe(413);
    expect(
      (await uploadPhoto(host.cookie, asset.id, 'SLOT', await png(200, 150), '', 'image/png')).json().code,
    ).toBe('media.too_small');
    for (let i = 0; i < 10; i++) {
      expect(
        (await uploadPhoto(host.cookie, asset.id, 'OTHER', await png(640, 480, 200 + i), '', 'image/png'))
          .statusCode,
      ).toBe(201);
    }
    expect(
      (await uploadPhoto(host.cookie, asset.id, 'OTHER', await png(640, 480, 300), '', 'image/png')).json()
        .code,
    ).toBe('media.limit_reached');
  });

  it("flags a near-duplicate of another host's photo for review", async () => {
    const a = await h.hostSignUp();
    const b = await h.hostSignUp();
    const assetA = (await createAsset(a.cookie, (await createProperty(a.cookie)).json().id)).json();
    const assetB = (await createAsset(b.cookie, (await createProperty(b.cookie)).json().id)).json();
    const photo = await png(1000, 750, 77);
    await uploadPhoto(a.cookie, assetA.id, 'SLOT', photo, '', 'image/png');
    const copy = await sharp(photo, { raw: undefined }).resize(900).jpeg({ quality: 70 }).toBuffer();
    const res = await uploadPhoto(b.cookie, assetB.id, 'SLOT', copy);
    const mediaId = res.json().media[0].id as string;
    const row = await db.pool.query('SELECT duplicate_suspected FROM assets.asset_media WHERE id = $1', [
      mediaId,
    ]);
    expect(row.rows[0].duplicate_suspected).toBe(true);
  });

  it('media visibility: owner always; public only for approved, non-entrance photos of published listings', async () => {
    const { host, asset } = await publishedParking(21);
    const slot = asset.media.find((m: { kind: string }) => m.kind === 'SLOT');
    const entrance = (
      await uploadPhoto(host.cookie, asset.id, 'ENTRANCE', await png(800, 600, 31), '', 'image/png')
    ).json();
    // Adding a photo to a live listing sends it back to review (material change).
    expect(entrance.status).toBe('PENDING_REVIEW');
    await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, {});
    const entranceId = entrance.media.find((m: { kind: string }) => m.kind === 'ENTRANCE').id;

    const anonymousSlot = await h.get(`/api/v1/media/${slot.id}`);
    expect(anonymousSlot.statusCode).toBe(200);
    expect(anonymousSlot.headers['content-type']).toBe('image/webp');
    expect(anonymousSlot.headers['cache-control']).toBe('public, max-age=3600');
    expect((await h.get(`/api/v1/media/${entranceId}`)).statusCode).toBe(404);
    const ownerEntrance = await h.get(`/api/v1/media/${entranceId}`, host.cookie);
    expect(ownerEntrance.statusCode).toBe(200);
    expect(ownerEntrance.headers['cache-control']).toBe('private, no-store');

    const draftHost = await h.hostSignUp();
    const draft = (
      await createAsset(draftHost.cookie, (await createProperty(draftHost.cookie)).json().id)
    ).json();
    const draftPhoto = (
      await uploadPhoto(draftHost.cookie, draft.id, 'SLOT', await png(800, 600, 41), '', 'image/png')
    ).json().media[0].id;
    expect((await h.get(`/api/v1/media/${draftPhoto}`)).statusCode).toBe(404);
    expect((await h.get(`/api/v1/media/${draftPhoto}`, host.cookie)).statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ lifecycle

describe('lifecycle and review', () => {
  it('cannot submit until the checklist is complete; then review publishes it', async () => {
    const host = await h.hostSignUp();
    const asset = (await createAsset(host.cookie, (await createProperty(host.cookie)).json().id)).json();
    const early = await send('POST', `/api/v1/host/assets/${asset.id}/submit`, host.cookie);
    expect(early.statusCode).toBe(422);
    expect(early.json().code).toBe('asset.not_ready');
    const ready = await makeReady(host.cookie, asset.id, 'PARKING', 51);
    expect(ready.checklist.ready).toBe(true);
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/submit`, host.cookie)).json().status).toBe(
      'PENDING_REVIEW',
    );

    const queue = (await h.get('/api/admin/review/assets', trustAdmin)).json() as {
      id: string;
      accessInstructions?: unknown;
    }[];
    const queued = queue.find((q) => q.id === asset.id);
    expect(queued).toBeDefined();
    expect(queued?.accessInstructions).toBeUndefined(); // reviewers don't need private access details

    const approved = (
      await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, { reason: 'photos match' })
    ).json();
    expect(approved.status).toBe('PUBLISHED');
    expect(approved.media.every((m: { moderationStatus: string }) => m.moderationStatus === 'APPROVED')).toBe(
      true,
    );
    const events = await db.pool.query(
      'SELECT from_status, to_status, actor_kind FROM assets.asset_events WHERE asset_id = $1 ORDER BY id',
      [asset.id],
    );
    expect(events.rows.map((e) => `${e.from_status}>${e.to_status}:${e.actor_kind}`)).toEqual([
      'null>DRAFT:HOST',
      'DRAFT>PENDING_REVIEW:HOST',
      'PENDING_REVIEW>PUBLISHED:PLATFORM_ADMIN',
    ]);
  });

  it('rejection returns the listing to draft with a reason', async () => {
    const host = await h.hostSignUp();
    const asset = (await createAsset(host.cookie, (await createProperty(host.cookie)).json().id)).json();
    await makeReady(host.cookie, asset.id, 'PARKING', 52);
    await send('POST', `/api/v1/host/assets/${asset.id}/submit`, host.cookie);
    expect((await send('POST', `/api/admin/assets/${asset.id}/reject`, trustAdmin, {})).statusCode).toBe(400); // reason required
    const rejected = (
      await send('POST', `/api/admin/assets/${asset.id}/reject`, trustAdmin, {
        reason: 'Photo shows a house number',
      })
    ).json();
    expect(rejected).toMatchObject({ status: 'DRAFT', statusReason: 'Photo shows a house number' });
  });

  it('pause, republish, material change while paused, and archive rules', async () => {
    const { host, asset } = await publishedParking(53);
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/archive`, host.cookie)).json().code).toBe(
      'asset.transition_not_allowed',
    );
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/pause`, host.cookie)).json().status).toBe(
      'PAUSED',
    );
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/republish`, host.cookie)).json().status).toBe(
      'PUBLISHED',
    );

    await send('POST', `/api/v1/host/assets/${asset.id}/pause`, host.cookie);
    const withPhoto = (
      await uploadPhoto(host.cookie, asset.id, 'OTHER', await png(800, 600, 54), '', 'image/png')
    ).json();
    expect(withPhoto).toMatchObject({ status: 'PAUSED', needsReview: true });
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/republish`, host.cookie)).json().status).toBe(
      'PENDING_REVIEW',
    );
    await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, {});

    await send('POST', `/api/v1/host/assets/${asset.id}/pause`, host.cookie);
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/archive`, host.cookie)).json().status).toBe(
      'ARCHIVED',
    );
    expect(
      (
        await send('PATCH', `/api/v1/host/assets/${asset.id}`, host.cookie, {
          version: 99,
          title: 'Back from the dead',
        })
      ).json().code,
    ).toBe('asset.archived');
    expect(
      ((await h.get('/api/v1/host/assets', host.cookie)).json() as { id: string }[]).some(
        (a) => a.id === asset.id,
      ),
    ).toBe(false);
  });

  it('moving the property sends its live listings back to review', async () => {
    const { host, property, asset } = await publishedParking(55);
    const current = (await h.get(`/api/v1/host/properties/${property.id}`, host.cookie)).json();
    await send('PATCH', `/api/v1/host/properties/${property.id}`, host.cookie, {
      version: current.version,
      latitude: 12.95,
      longitude: 77.61,
    });
    expect((await h.get(`/api/v1/host/assets/${asset.id}`, host.cookie)).json().status).toBe(
      'PENDING_REVIEW',
    );
  });

  it('admins can suspend and reinstate; hosts cannot self-reinstate', async () => {
    const { host, asset } = await publishedParking(56);
    expect(
      (
        await send('POST', `/api/admin/assets/${asset.id}/suspend`, trustAdmin, {
          reason: 'Customer reports: not the pictured spot',
        })
      ).json().status,
    ).toBe('SUSPENDED');
    expect((await send('POST', `/api/v1/host/assets/${asset.id}/republish`, host.cookie)).statusCode).toBe(
      409,
    );
    expect(
      (
        await send('POST', `/api/admin/assets/${asset.id}/reinstate`, trustAdmin, {
          reason: 'Verified on site',
        })
      ).json().status,
    ).toBe('PAUSED');
  });
});

// ------------------------------------------------------------------ societies (BR-32)

describe('apartment societies', () => {
  const societyBody = {
    address: 'Prestige Residency, Bellandur, Bengaluru',
    ...BLR,
    areaLabel: 'Bellandur',
    displayName: 'Prestige Residency',
    outsiderCap: 5,
  };

  it('full lifecycle: consent gating, membership, participation changes suspend listings', async () => {
    const society = (await send('POST', '/api/admin/properties/societies', trustAdmin, societyBody)).json();
    expect(society).toMatchObject({
      kind: 'APARTMENT_SOCIETY',
      participationStatus: 'CONSENT_REQUIRED',
      outsiderCap: 5,
    });

    const resident = await h.hostSignUp();
    expect((await createAsset(resident.cookie, society.id)).json().code).toBe('asset.property_unavailable');

    await send('POST', `/api/admin/properties/${society.id}/member-hosts`, trustAdmin, {
      hostAccountId: resident.hostAccountId,
    });
    const asset = (await createAsset(resident.cookie, society.id)).json();
    const ready = await makeReady(resident.cookie, asset.id, 'PARKING', 61);
    expect(ready.checklist.missing).toEqual(['SOCIETY_NOT_PARTICIPATING']);

    const skip = await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
      status: 'PARTICIPATING',
      reason: 'skip',
    });
    expect(skip.json().code).toBe('property.transition_not_allowed');
    await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
      status: 'PENDING_CONSENT',
      reason: 'committee meeting',
    });
    await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
      status: 'PARTICIPATING',
      reason: 'resolution received',
    });

    await send('POST', `/api/v1/host/assets/${asset.id}/submit`, resident.cookie);
    expect((await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, {})).json().status).toBe(
      'PUBLISHED',
    );

    await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
      status: 'SUSPENDED',
      reason: 'resident complaints',
    });
    const suspended = (await h.get(`/api/v1/host/assets/${asset.id}`, resident.cookie)).json();
    expect(suspended).toMatchObject({ status: 'SUSPENDED', statusReason: 'society participation suspended' });

    const history = await db.pool.query(
      'SELECT from_status, to_status FROM properties.property_events WHERE property_id = $1 ORDER BY id',
      [society.id],
    );
    expect(history.rows.map((r) => `${r.from_status}>${r.to_status}`)).toEqual([
      'null>CONSENT_REQUIRED',
      'CONSENT_REQUIRED>PENDING_CONSENT',
      'PENDING_CONSENT>PARTICIPATING',
      'PARTICIPATING>SUSPENDED',
    ]);
  });

  it('approval re-checks consent: a society suspended after submission blocks approval', async () => {
    const society = (await send('POST', '/api/admin/properties/societies', trustAdmin, societyBody)).json();
    const resident = await h.hostSignUp();
    await send('POST', `/api/admin/properties/${society.id}/member-hosts`, trustAdmin, {
      hostAccountId: resident.hostAccountId,
    });
    for (const status of ['PENDING_CONSENT', 'PARTICIPATING']) {
      await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
        status,
        reason: 'onboarding',
      });
    }
    const asset = (await createAsset(resident.cookie, society.id)).json();
    await makeReady(resident.cookie, asset.id, 'PARKING', 62);
    await send('POST', `/api/v1/host/assets/${asset.id}/submit`, resident.cookie);
    await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
      status: 'SUSPENDED',
      reason: 'paused',
    });
    // The pending listing itself was suspended by the participation change.
    expect((await h.get(`/api/v1/host/assets/${asset.id}`, resident.cookie)).json().status).toBe('SUSPENDED');
    expect((await send('POST', `/api/admin/assets/${asset.id}/approve`, trustAdmin, {})).statusCode).toBe(
      409,
    );
  });

  it('revoking a member suspends only that host’s listings', async () => {
    const society = (await send('POST', '/api/admin/properties/societies', trustAdmin, societyBody)).json();
    for (const status of ['PENDING_CONSENT', 'PARTICIPATING']) {
      await send('POST', `/api/admin/properties/${society.id}/participation`, trustAdmin, {
        status,
        reason: 'onboarding',
      });
    }
    const a = await h.hostSignUp();
    const b = await h.hostSignUp();
    for (const host of [a, b]) {
      await send('POST', `/api/admin/properties/${society.id}/member-hosts`, trustAdmin, {
        hostAccountId: host.hostAccountId,
      });
    }
    const assetA = (await createAsset(a.cookie, society.id)).json();
    const assetB = (await createAsset(b.cookie, society.id)).json();
    await h.app.inject({
      method: 'DELETE',
      url: `/api/admin/properties/${society.id}/member-hosts/${a.hostAccountId}`,
      headers: { ...CSRF, cookie: trustAdmin },
    });
    expect((await h.get(`/api/v1/host/assets/${assetA.id}`, a.cookie)).json()).toMatchObject({
      status: 'SUSPENDED',
      checklist: { missing: expect.arrayContaining(['NOT_A_MEMBER']) },
    });
    expect((await h.get(`/api/v1/host/assets/${assetB.id}`, b.cookie)).json().status).toBe('DRAFT');
  });
});

// ------------------------------------------------------------------ admin authorisation

describe('admin authorisation', () => {
  it('review and society endpoints need an admin session with TRUST_SAFETY', async () => {
    const support = await h.adminSignIn(['SUPPORT']);
    const user = await h.signUp();
    expect((await h.get('/api/admin/review/assets', support)).statusCode).toBe(403);
    expect((await h.get('/api/admin/review/assets', user.cookie)).statusCode).toBe(401);
    expect((await h.get('/api/admin/review/assets')).statusCode).toBe(401);
    const superAdmin = await h.adminSignIn(['SUPER_ADMIN']);
    expect((await h.get('/api/admin/review/assets', superAdmin)).statusCode).toBe(200);
  });
});
