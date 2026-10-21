import { describe, expect, it } from 'vitest';
import { coarsePoint, fixtureGeocoder } from '../../src/platform/providers/geocoding.ts';
import {
  canonicalLocality,
  decodePlaceId,
  encodePlaceId,
  photonGeocoder,
} from '../../src/platform/providers/photon.ts';

const feature = (name: string | undefined, lat: number, lng: number, extra: Record<string, string> = {}) => ({
  geometry: { coordinates: [lng, lat] },
  properties: { ...(name ? { name } : {}), city: 'Bengaluru', ...extra },
});

function scripted(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const body = responses[path];
    if (body instanceof Error) throw body;
    if (body === 503) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(body ?? { features: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const geocoder = (fetchFn: typeof fetch) =>
  photonGeocoder({
    baseUrl: 'https://photon.test',
    bias: { latitude: 12.9716, longitude: 77.5946 },
    bbox: [77.3, 12.7, 77.95, 13.3],
    userAgent: 'ParkBro-test',
    fallback: fixtureGeocoder(),
    fetch: fetchFn,
  });

describe('photon place search (D-174)', () => {
  it('maps results to predictions with locality context, de-duplicates and carries the point in the id', async () => {
    const { fetchFn, calls } = scripted({
      '/api/': {
        features: [
          feature('Forum Mall Koramangala', 12.935, 77.6121, { district: 'Kormangala West' }),
          feature('Forum Mall Koramangala', 12.93502, 77.61212, { district: 'Kormangala West' }), // duplicate
          feature(undefined, 12.94, 77.62, { street: '8th Main Road', housenumber: '12' }),
          feature(undefined, 12.95, 77.63), // no name, no street: skipped
        ],
      },
    });
    const g = geocoder(fetchFn);
    const results = await g.autocomplete('forum mall');
    expect(results.map((r) => [r.primaryText, r.secondaryText])).toEqual([
      ['Forum Mall Koramangala', 'Kormangala West, Bengaluru'],
      ['12 8th Main Road', 'Bengaluru'],
    ]);
    const url = new URL(calls[0] ?? '');
    expect(url.searchParams.get('bbox')).toBe('77.3,12.7,77.95,13.3');
    expect(url.searchParams.get('lat')).toBe('12.9716');
    expect(await g.details(results[0]?.placeId ?? '')).toEqual({
      placeId: results[0]?.placeId,
      name: 'Forum Mall Koramangala',
      latitude: 12.935,
      longitude: 77.6121,
    });
    // Cached: a repeat search doesn't call Photon again.
    await g.autocomplete('Forum Mall ');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the built-in localities when Photon is down or slow', async () => {
    const down = geocoder(scripted({ '/api/': 503, '/reverse': new Error('timeout') }).fetchFn);
    const results = await down.autocomplete('koram');
    expect(results[0]).toMatchObject({ primaryText: 'Koramangala' });
    expect(await down.details(results[0]?.placeId ?? '')).toMatchObject({ name: 'Koramangala' });
    expect(await down.areaAt(12.93, 77.62)).toBe('Koramangala');
  });

  it('area labels are localities, never streets', async () => {
    const g = geocoder(
      scripted({
        '/reverse': {
          features: [feature('8th Main Road', 12.935, 77.6245, { district: 'Kormangala East' })],
        },
      }).fetchFn,
    );
    expect(await g.areaAt(12.94, 77.62)).toBe('Koramangala'); // OSM "Kormangala East" tidied to the known name
    expect(coarsePoint(12.935249, 77.624551)).toEqual({ latitude: 12.935, longitude: 77.625 });
    expect(canonicalLocality('Kormangala West')).toBe('Koramangala');
    expect(canonicalLocality('HSR Layout Sector 2')).toBe('HSR Layout');
    expect(canonicalLocality('Lakkasandra')).toBe('Lakkasandra'); // a real neighbourhood we don't know: kept
    expect(canonicalLocality('Indiranagar')).toBe('Indiranagar');
  });

  it('place ids stay under the 100-character URL limit and reject tampering', () => {
    const long = encodePlaceId('ಕೋರಮಂಗಲ ಫೋರಂ ಮಾಲ್ ಹೊಸೂರು ರಸ್ತೆ ಬೆಂಗಳೂರು ಕರ್ನಾಟಕ', 12.935, 77.6121);
    expect(long.length).toBeLessThan(100);
    expect(decodePlaceId(long)?.latitude).toBe(12.935);
    expect(decodePlaceId('osm:95.0,77.6:S29y')).toBeNull();
    expect(decodePlaceId('osm:12.9,77.6:')).toBeNull();
    expect(decodePlaceId('fixture:koramangala')).toBeNull();
  });
});
