/** Public presentation rules (trust-and-safety §9, L-2, L-3, L-7, L-8). Pure. */

/** L-2: distances are shown rounded to 100 m (minimum 100 m) and are measured from the fuzzed public point. */
export function roundDistance(meters: number): number {
  return Math.max(100, Math.round(meters / 100) * 100);
}

export type PropertyKind = 'APARTMENT_SOCIETY' | 'INDEPENDENT_HOUSE' | 'COMMERCIAL' | 'OFFICE' | 'OTHER';

/** Public coordinates are rounded to 3 decimals (~110 m): extra blur on top of the fuzzed point; no metre precision. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** L-3: residential (and unknown) places are an approximate area; commercial and office may be a pin. */
export function locationPrecision(kind: PropertyKind): { precision: 'AREA' | 'PIN'; radiusM: number } {
  return kind === 'COMMERCIAL' || kind === 'OFFICE'
    ? { precision: 'PIN', radiusM: 0 }
    : { precision: 'AREA', radiusM: 500 };
}

/** L-7: residential listings don't reveal how many spaces a property has. */
export function publicSpaceCount(kind: PropertyKind, activeUnits: number): number | null {
  return kind === 'COMMERCIAL' || kind === 'OFFICE' ? activeUnits : null;
}

/** L-8: individual hosts are shown by first name only; business hosts by business name. */
export function publicHostName(displayName: string, kind: 'INDIVIDUAL' | 'BUSINESS'): string {
  if (kind === 'BUSINESS') return displayName;
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

const MODE_PREFERENCE = ['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION'] as const;
export { MODE_PREFERENCE };

const VEHICLE_ORDER = ['HATCHBACK', 'SEDAN', 'SUV', 'MUV'] as const;
export type VehicleClass = (typeof VEHICLE_ORDER)[number];
export { VEHICLE_ORDER };

/** Classes that fit a space whose largest allowed vehicle is `max`. */
export function fitsVehicle(max: VehicleClass, vehicle: VehicleClass): boolean {
  return VEHICLE_ORDER.indexOf(max) >= VEHICLE_ORDER.indexOf(vehicle);
}
