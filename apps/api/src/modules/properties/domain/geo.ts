/** Geography helpers for privacy-preserving locations (trust-and-safety.md §9). */
export interface LatLng {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Pilot market is India (D-004): reject points outside a generous bounding box. */
export function isInIndia({ latitude, longitude }: LatLng): boolean {
  return latitude >= 6 && latitude <= 37.5 && longitude >= 68 && longitude <= 97.5;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function destination(from: LatLng, distanceM: number, bearingRad: number): LatLng {
  const angular = distanceM / EARTH_RADIUS_M;
  const lat1 = toRad(from.latitude);
  const lng1 = toRad(from.longitude);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearingRad),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latitude: toDeg(lat2), longitude: ((toDeg(lng2) + 540) % 360) - 180 };
}

export type PropertyKind = 'APARTMENT_SOCIETY' | 'INDEPENDENT_HOUSE' | 'COMMERCIAL' | 'OFFICE' | 'OTHER';

/** L-1 offset ranges: residential (and unknown) 200–500 m, commercial and office 0–100 m. */
export function fuzzRange(kind: PropertyKind): { minM: number; maxM: number } {
  return kind === 'COMMERCIAL' || kind === 'OFFICE' ? { minM: 0, maxM: 100 } : { minM: 200, maxM: 500 };
}

/**
 * L-1: a random offset applied ONCE when the point is set and stored as the public point. All public queries use
 * it, so repeated searches can't be averaged back to the real location. A new random offset is drawn only if
 * the exact point changes.
 */
export function fuzzPoint(exact: LatLng, kind: PropertyKind, random: () => number = Math.random): LatLng {
  const { minM, maxM } = fuzzRange(kind);
  const distance = minM + random() * (maxM - minM);
  const bearing = random() * 2 * Math.PI;
  return destination(exact, distance, bearing);
}

export function formatPoint({ latitude, longitude }: LatLng): string {
  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export function parsePoint(value: string): LatLng {
  const [lat, lng] = value.split(',').map(Number);
  return { latitude: lat ?? NaN, longitude: lng ?? NaN };
}
