import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  isAfter,
  queryFingerprint,
} from '../../src/modules/discovery/domain/cursor.ts';
import {
  fitsVehicle,
  locationPrecision,
  publicHostName,
  publicSpaceCount,
  roundCoordinate,
  roundDistance,
} from '../../src/modules/discovery/domain/presentation.ts';

describe('public presentation rules', () => {
  it('rounds distances to 100 m with a 100 m floor (L-2)', () => {
    expect([0, 49, 149, 151, 1049, 2250].map(roundDistance)).toEqual([100, 100, 100, 200, 1000, 2300]);
  });
  it('rounds coordinates to 3 decimals', () => {
    expect(roundCoordinate(12.936998640727447)).toBe(12.937);
    expect(roundCoordinate(77.62450000000001)).toBe(77.625);
  });
  it('residential is an area, commercial and office a pin (L-3)', () => {
    expect(locationPrecision('INDEPENDENT_HOUSE')).toEqual({ precision: 'AREA', radiusM: 500 });
    expect(locationPrecision('APARTMENT_SOCIETY').precision).toBe('AREA');
    expect(locationPrecision('OTHER').precision).toBe('AREA');
    expect(locationPrecision('COMMERCIAL').precision).toBe('PIN');
    expect(locationPrecision('OFFICE').precision).toBe('PIN');
  });
  it('hides space counts for residential (L-7)', () => {
    expect(publicSpaceCount('INDEPENDENT_HOUSE', 3)).toBeNull();
    expect(publicSpaceCount('COMMERCIAL', 3)).toBe(3);
  });
  it('shows individuals by first name only (L-8)', () => {
    expect(publicHostName('  Priya   Sharma ', 'INDIVIDUAL')).toBe('Priya');
    expect(publicHostName('Brigade Parking Pvt Ltd', 'BUSINESS')).toBe('Brigade Parking Pvt Ltd');
  });
  it('vehicle fit is by size order', () => {
    expect(fitsVehicle('SUV', 'SEDAN')).toBe(true);
    expect(fitsVehicle('SEDAN', 'SUV')).toBe(false);
    expect(fitsVehicle('MUV', 'MUV')).toBe(true);
  });
});

describe('search cursors', () => {
  const fp = queryFingerprint({ lat: 1, lng: 2, type: 'PARKING' });
  it('round-trips and binds to the query', () => {
    const c = encodeCursor({ key: [1234.5], id: 'b' }, fp);
    expect(decodeCursor(c, fp)).toEqual({ key: [1234.5], id: 'b' });
    expect(decodeCursor(c, queryFingerprint({ lat: 1, lng: 2, type: 'EV_CHARGING' }))).toBeNull();
  });
  it('fingerprints are independent of key order', () => {
    expect(queryFingerprint({ a: 1, b: 2 })).toBe(queryFingerprint({ b: 2, a: 1 }));
  });
  it('rejects garbage', () => {
    for (const bad of ['', 'x', Buffer.from('{"k":["1"],"i":"a","q":"' + fp + '"}').toString('base64url')]) {
      expect(decodeCursor(bad, fp)).toBeNull();
    }
  });
  it('compares (key…, id) lexicographically', () => {
    expect(isAfter({ key: [2], id: 'a' }, { key: [1], id: 'z' })).toBe(true);
    expect(isAfter({ key: [1], id: 'b' }, { key: [1], id: 'a' })).toBe(true);
    expect(isAfter({ key: [1], id: 'a' }, { key: [1], id: 'a' })).toBe(false);
    expect(isAfter({ key: [5, 1], id: 'a' }, { key: [5, 2], id: 'a' })).toBe(false);
  });
});
