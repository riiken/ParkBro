import { KNOWN_LOCALITIES, type Geocoder, type PlaceDetails, type PlacePrediction } from './geocoding.ts';

/**
 * Photon (OpenStreetMap) place search (D-174): no key, returns coordinates. Results are biased to and bounded by
 * the pilot city. Searches are cached for 10 minutes to stay within the public instance's fair use; on any
 * failure the fallback (the Bengaluru fixture) answers, so place search never breaks.
 *
 * A place id carries its own point ("osm:<lat>,<lng>:<name>"): Photon has no lookup-by-id, and the point is
 * public map data. Ids stay under the 100-character URL parameter limit.
 */
export interface PhotonOptions {
  baseUrl: string;
  /** Search bias (city centre). */
  bias: { latitude: number; longitude: number };
  /** minLon,minLat,maxLon,maxLat: only places inside are returned. */
  bbox: [number, number, number, number];
  userAgent: string;
  fallback: Geocoder;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    locality?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    type?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const MAX_NAME_BYTES = 40;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function clipUtf8(text: string, maxBytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

export function encodePlaceId(name: string, latitude: number, longitude: number): string {
  return `osm:${latitude.toFixed(5)},${longitude.toFixed(5)}:${b64(clipUtf8(name, MAX_NAME_BYTES))}`;
}

export function decodePlaceId(placeId: string): PlaceDetails | null {
  const m = /^osm:(-?\d{1,2}\.\d{1,6}),(-?\d{1,3}\.\d{1,6}):([A-Za-z0-9_-]{1,60})$/.exec(placeId);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const name = unb64(m[3] ?? '').trim();
  if (!name) return null;
  return { placeId, name, latitude, longitude };
}

/** Neighbourhood-level names from a Photon feature (never a street or building), tidied; empty sub-areas dropped. */
function localityCandidates(p: PhotonFeature['properties']): string[] {
  return [p.locality, p.district, p.city]
    .filter((x): x is string => Boolean(x) && squash(x as string).length > 0)
    .map(canonicalLocality);
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(
      /\b(east|west|north|south|central|ward|\d+(st|nd|rd|th)?\s*(block|stage|phase|sector)|(block|stage|phase|sector)\s*\d+)\b/g,
      '',
    )
    .replace(/[^a-z]/g, '');

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  return (d[a.length] as number[])[b.length] as number;
}

/** Map OSM spellings and sub-areas onto the well-known name when they clearly mean it. */
export function canonicalLocality(name: string): string {
  const s = squash(name);
  if (!s) return name;
  for (const known of KNOWN_LOCALITIES) {
    const k = squash(known);
    if (s === k || (s.length >= 6 && editDistance(s, k) <= 2)) return known;
  }
  return name.trim();
}

export function photonGeocoder(options: PhotonOptions): Geocoder {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const cache = new Map<string, { at: number; value: PlacePrediction[] }>();

  async function get(path: string, params: Record<string, string>): Promise<PhotonFeature[]> {
    const url = `${options.baseUrl.replace(/\/$/, '')}${path}?${new URLSearchParams(params)}`;
    const res = await doFetch(url, {
      headers: { 'user-agent': options.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`photon http ${res.status}`);
    const body = (await res.json()) as { features?: PhotonFeature[] };
    return body.features ?? [];
  }

  return {
    name: 'photon',
    async autocomplete(query) {
      const key = query.trim().toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
      try {
        const features = await get('/api/', {
          q: query.trim(),
          lat: String(options.bias.latitude),
          lon: String(options.bias.longitude),
          bbox: options.bbox.join(','),
          limit: '10',
          lang: 'en',
        });
        const seen = new Set<string>();
        const value: PlacePrediction[] = [];
        for (const f of features) {
          const p = f.properties;
          const name = p.name ?? (p.street ? `${p.housenumber ? `${p.housenumber} ` : ''}${p.street}` : null);
          if (!name) continue;
          const [longitude, latitude] = f.geometry.coordinates;
          const where = [p.district ?? p.locality, p.city ?? p.county]
            .filter((x): x is string => Boolean(x) && x !== name)
            .filter((x, i, all) => all.indexOf(x) === i);
          const dedupe = `${name.toLowerCase()}@${latitude.toFixed(3)},${longitude.toFixed(3)}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          value.push({
            placeId: encodePlaceId(name, latitude, longitude),
            primaryText: name,
            secondaryText: where.join(', ') || 'Bengaluru',
          });
          if (value.length === 8) break;
        }
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: Date.now(), value });
        return value;
      } catch {
        return options.fallback.autocomplete(query);
      }
    },
    async details(placeId) {
      return decodePlaceId(placeId) ?? options.fallback.details(placeId);
    },
    async areaAt(latitude, longitude) {
      let candidates: string[] = [];
      try {
        const [first] = await get('/reverse', {
          lat: String(latitude),
          lon: String(longitude),
          lang: 'en',
          limit: '1',
        });
        candidates = first ? localityCandidates(first.properties) : [];
      } catch {
        // fall through to the known localities
      }
      // 1. An OSM name that is a well-known locality ("Kormangala West" → "Koramangala").
      const known = candidates.find((c) => KNOWN_LOCALITIES.includes(c));
      if (known) return known;
      // 2. A well-known locality centred within 1 km; 3. OSM's own neighbourhood; 4. nearest known within 4 km.
      return (
        (await options.fallback.areaAt(latitude, longitude, 1)) ??
        candidates[0] ??
        options.fallback.areaAt(latitude, longitude)
      );
    },
  };
}
