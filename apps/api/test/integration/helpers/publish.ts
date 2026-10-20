import type { LightMyRequestResponse } from 'fastify';
import { CSRF, type IdentityHarness } from './identity-app.ts';
import { png } from './images.ts';

export interface ListingSpec {
  kind?: 'INDEPENDENT_HOUSE' | 'COMMERCIAL' | 'OFFICE' | 'OTHER';
  latitude: number;
  longitude: number;
  address?: string;
  areaLabel?: string;
  type?: 'PARKING' | 'EV_CHARGING';
  title?: string;
  accessInstructions?: string;
  parking?: Record<string, unknown>;
  charger?: Record<string, unknown>;
  rates?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
  units?: string[];
  asset?: Record<string, unknown>;
  extraPhotos?: { kind: string; seed: number }[];
  seed: number;
  publish?: boolean;
}

/** Creates a host, property and listing through the real API and (by default) gets it approved and published. */
export async function publishListing(h: IdentityHarness, admin: string, spec: ListingSpec) {
  const host = await h.hostSignUp(spec.title ? `Host ${spec.seed}` : 'Asha Rao');
  const send = (method: 'POST' | 'PUT', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: { ...CSRF, cookie: host.cookie }, ...(payload ? { payload } : {}) });
  const ok = async (p: Promise<LightMyRequestResponse>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`publishListing step failed ${res.statusCode}: ${res.body}`);
    return res;
  };
  const type = spec.type ?? 'PARKING';

  const property = (
    await ok(
      send('POST', '/api/v1/host/properties', {
        kind: spec.kind ?? 'INDEPENDENT_HOUSE',
        address: spec.address ?? `${spec.seed}, Test Street, Bengaluru`,
        latitude: spec.latitude,
        longitude: spec.longitude,
        areaLabel: spec.areaLabel ?? 'Koramangala',
      }),
    )
  ).json() as { id: string };
  const asset = (
    await ok(
      send('POST', '/api/v1/host/assets', {
        propertyId: property.id,
        type,
        title: spec.title ?? `Listing number ${spec.seed}`,
        accessInstructions: spec.accessInstructions ?? null,
      }),
    )
  ).json() as { id: string; version: number };
  const base = `/api/v1/host/assets/${asset.id}`;

  if (spec.asset) {
    await ok(
      h.app.inject({
        method: 'PATCH',
        url: base,
        headers: { ...CSRF, cookie: host.cookie },
        payload: { version: asset.version, ...spec.asset },
      }),
    );
  }
  await ok(
    send('PUT', `${base}/parking-details`, {
      covered: true,
      level: 'GROUND',
      maxVehicleClass: 'SEDAN',
      ...spec.parking,
    }),
  );
  if (type === 'EV_CHARGING') {
    await ok(
      send('PUT', `${base}/charger-details`, {
        connectors: ['TYPE2'],
        currentType: 'AC',
        powerKw: 7.4,
        cableProvided: true,
        connectionType: 'EV_METERED',
        ...spec.charger,
      }),
    );
    await ok(send('POST', `${base}/attestations`, { kind: 'CHARGER_SAFETY', accepted: true }));
  }
  if (spec.units) await ok(send('PUT', `${base}/units`, { labels: spec.units }));
  await ok(
    send('PUT', `${base}/rates`, {
      rates:
        spec.rates ??
        (type === 'PARKING'
          ? [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 }]
          : [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 12000 }]),
    }),
  );
  await ok(
    send('PUT', `${base}/availability-rules`, {
      rules: spec.rules ?? [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '00:00' }],
    }),
  );
  await ok(send('POST', `${base}/attestations`, { kind: 'RIGHT_TO_RENT', accepted: true }));
  for (const photo of [
    { kind: 'SLOT', seed: spec.seed },
    ...(type === 'EV_CHARGING' ? [{ kind: 'CHARGER', seed: spec.seed + 1000 }] : []),
    ...(spec.extraPhotos ?? []),
  ]) {
    await ok(
      h.app.inject({
        method: 'POST',
        url: `${base}/media?kind=${photo.kind}`,
        headers: { ...CSRF, cookie: host.cookie, 'content-type': 'image/png' },
        payload: await png(640, 480, photo.seed),
      }),
    );
  }
  if (spec.publish !== false) {
    await ok(send('POST', `${base}/submit`));
    await ok(
      h.app.inject({
        method: 'POST',
        url: `/api/admin/assets/${asset.id}/approve`,
        headers: { ...CSRF, cookie: admin },
        payload: {},
      }),
    );
  }
  return { host, propertyId: property.id, assetId: asset.id };
}
