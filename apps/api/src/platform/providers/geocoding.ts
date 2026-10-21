/**
 * Place search for "where do you need parking?" (architecture.md §5 MapsProvider). Only public places (localities,
 * landmarks) are geocoded; host properties are never sent to or resolved by a maps provider.
 * Providers: a fixture of Bengaluru localities (tests, offline) and Photon over OpenStreetMap (D-174).
 */
export interface PlacePrediction {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface Geocoder {
  readonly name: string;
  autocomplete(query: string): Promise<PlacePrediction[]>;
  details(placeId: string): Promise<PlaceDetails | null>;
  /**
   * Locality name (never a street or building) around a point, for a property's public area label. Callers pass a
   * point rounded to ~110 m, no finer than the public point every listing already shows (D-174).
   */
  areaAt(latitude: number, longitude: number, withinKm?: number): Promise<string | null>;
}

// Public locality centroids (approximate), Bengaluru pilot.
const BENGALURU: [string, string, number, number][] = [
  ['koramangala', 'Koramangala', 12.9352, 77.6245],
  ['indiranagar', 'Indiranagar', 12.9719, 77.6412],
  ['hsr-layout', 'HSR Layout', 12.9116, 77.6474],
  ['bellandur', 'Bellandur', 12.9304, 77.6784],
  ['whitefield', 'Whitefield', 12.9698, 77.75],
  ['marathahalli', 'Marathahalli', 12.9569, 77.7011],
  ['electronic-city', 'Electronic City', 12.8452, 77.6602],
  ['jayanagar', 'Jayanagar', 12.925, 77.5938],
  ['btm-layout', 'BTM Layout', 12.9166, 77.6101],
  ['mg-road', 'MG Road', 12.9756, 77.6066],
  ['malleshwaram', 'Malleshwaram', 13.0035, 77.571],
  ['hebbal', 'Hebbal', 13.0358, 77.597],
  ['yelahanka', 'Yelahanka', 13.1007, 77.5963],
  ['majestic', 'Majestic (Kempegowda Bus Station)', 12.9767, 77.5713],
  ['kia-airport', 'Kempegowda International Airport', 13.1986, 77.7066],
];

export function fixtureGeocoder(): Geocoder {
  const places = BENGALURU.map(([id, name, latitude, longitude]) => ({
    placeId: `fixture:${id}`,
    name,
    latitude,
    longitude,
  }));
  return {
    name: 'fixture',
    async autocomplete(query) {
      const q = query.trim().toLowerCase();
      if (q.length < 2) return [];
      return places
        .filter((p) => p.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((p) => ({ placeId: p.placeId, primaryText: p.name, secondaryText: 'Bengaluru, Karnataka' }));
    },
    async details(placeId) {
      return places.find((p) => p.placeId === placeId) ?? null;
    },
    async areaAt(latitude, longitude, withinKm = 4) {
      const nearest = places
        .map((p) => ({ p, d: distanceKm(latitude, longitude, p.latitude, p.longitude) }))
        .sort((a, b) => a.d - b.d)[0];
      return nearest && nearest.d <= withinKm ? nearest.p.name : null;
    },
  };
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** Round to ~110 m (3 decimals) before a point leaves the platform for an area lookup (D-174). */
export const coarsePoint = (latitude: number, longitude: number) => ({
  latitude: Math.round(latitude * 1000) / 1000,
  longitude: Math.round(longitude * 1000) / 1000,
});

/** Known pilot locality names, used to tidy OpenStreetMap's variants ("Kormangala West" → "Koramangala"). */
export const KNOWN_LOCALITIES = BENGALURU.map(([, name]) => name);
