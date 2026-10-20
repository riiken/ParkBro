import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  assetCheck,
  availableUnits,
  checkUnit,
  freeTime,
  maxConcurrent,
  subtract,
  type AssetAvailabilityInput,
} from '../../src/modules/availability/domain/engine.ts';

const IST = 'Asia/Kolkata';
const t = (iso: string, zone = IST) => DateTime.fromISO(iso, { zone }).toMillis();
const H = 3_600_000;
const iso = (ms: number) => DateTime.fromMillis(ms, { zone: IST }).toFormat('ccc HH:mm');

// 2026-11-02 is a Monday.
const base: AssetAvailabilityInput = {
  timezone: IST,
  bufferMinutes: 0,
  unitIds: ['u1', 'u2'],
  rules: [
    {
      weekdays: [1, 2, 3, 4, 5],
      startLocal: '09:00',
      endLocal: '19:00',
      validFrom: '2026-01-01',
      validTo: null,
    },
  ],
  exceptions: [],
  reservations: [],
};

describe('interval subtraction', () => {
  it('handles disjoint, partial, contained and covering holes', () => {
    const a = [{ start: 0, end: 100 }];
    expect(subtract(a, [{ start: 200, end: 300 }])).toEqual([{ start: 0, end: 100 }]);
    expect(subtract(a, [{ start: 20, end: 40 }])).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 100 },
    ]);
    expect(
      subtract(a, [
        { start: -10, end: 30 },
        { start: 90, end: 120 },
      ]),
    ).toEqual([{ start: 30, end: 90 }]);
    expect(subtract(a, [{ start: 0, end: 100 }])).toEqual([]);
    expect(
      subtract(a, [
        { start: 10, end: 20 },
        { start: 15, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 100 },
    ]);
  });
});

describe('free time and window checks', () => {
  it('rules define open time per unit, in local time', () => {
    const free = freeTime(base, t('2026-11-02T00:00'), t('2026-11-03T00:00'));
    expect(free.get('u1')?.map((i) => `${iso(i.start)}-${iso(i.end)}`)).toEqual(['Mon 09:00-Mon 19:00']);
    expect(checkUnit(base, 'u1', t('2026-11-02T10:00'), t('2026-11-02T12:00'))).toEqual({ available: true });
    expect(checkUnit(base, 'u1', t('2026-11-07T10:00'), t('2026-11-07T12:00'))).toEqual({
      available: false,
      reason: 'CLOSED',
    });
  });

  it('an asset-wide BLOCK applies to every unit; a unit BLOCK to one unit', () => {
    const lunch = {
      id: 'b1',
      unitId: null,
      kind: 'BLOCK' as const,
      start: t('2026-11-02T13:00'),
      end: t('2026-11-02T14:00'),
    };
    const u2Only = {
      id: 'b2',
      unitId: 'u2',
      kind: 'BLOCK' as const,
      start: t('2026-11-02T09:00'),
      end: t('2026-11-02T19:00'),
    };
    const input = { ...base, exceptions: [lunch, u2Only] };
    expect(checkUnit(input, 'u1', t('2026-11-02T12:30'), t('2026-11-02T13:30'))).toEqual({
      available: false,
      reason: 'BLOCKED',
    });
    expect(checkUnit(input, 'u1', t('2026-11-02T14:00'), t('2026-11-02T15:00'))).toEqual({ available: true }); // block end exclusive
    expect(availableUnits(input, t('2026-11-02T10:00'), t('2026-11-02T11:00'))).toEqual(['u1']);
    expect(freeTime(input, t('2026-11-02T00:00'), t('2026-11-03T00:00')).get('u2')).toEqual([]);
  });

  it('OPEN exceptions add time outside the weekly rules (e.g. a Saturday event)', () => {
    const saturday = {
      id: 'o1',
      unitId: null,
      kind: 'OPEN' as const,
      start: t('2026-11-07T08:00'),
      end: t('2026-11-07T20:00'),
    };
    const input = { ...base, exceptions: [saturday] };
    expect(checkUnit(input, 'u1', t('2026-11-07T10:00'), t('2026-11-07T12:00'))).toEqual({ available: true });
    // An opening adjacent to the rule merges: Mon 07:00–09:00 opening + 09:00–19:00 rule is one period.
    const early = {
      id: 'o2',
      unitId: null,
      kind: 'OPEN' as const,
      start: t('2026-11-02T07:00'),
      end: t('2026-11-02T09:00'),
    };
    expect(
      checkUnit({ ...base, exceptions: [early] }, 'u1', t('2026-11-02T08:00'), t('2026-11-02T10:00')),
    ).toEqual({ available: true });
  });

  it('a BLOCK wins over an OPEN for the same time', () => {
    const open = {
      id: 'o',
      unitId: null,
      kind: 'OPEN' as const,
      start: t('2026-11-07T08:00'),
      end: t('2026-11-07T20:00'),
    };
    const block = {
      id: 'b',
      unitId: null,
      kind: 'BLOCK' as const,
      start: t('2026-11-07T10:00'),
      end: t('2026-11-07T11:00'),
    };
    expect(
      checkUnit({ ...base, exceptions: [open, block] }, 'u1', t('2026-11-07T10:30'), t('2026-11-07T11:30'))
        .available,
    ).toBe(false);
  });

  it('reservations: overlapping rejected, adjacent allowed with zero buffer (half-open)', () => {
    const input = {
      ...base,
      reservations: [{ unitId: 'u1', start: t('2026-11-02T10:00'), blockedUntil: t('2026-11-02T12:00') }],
    };
    expect(checkUnit(input, 'u1', t('2026-11-02T11:00'), t('2026-11-02T13:00'))).toEqual({
      available: false,
      reason: 'RESERVED',
    });
    expect(checkUnit(input, 'u1', t('2026-11-02T12:00'), t('2026-11-02T14:00'))).toEqual({ available: true });
    expect(checkUnit(input, 'u1', t('2026-11-02T08:00'), t('2026-11-02T10:00')).available).toBe(false); // 08:00 is before opening
    expect(checkUnit(input, 'u1', t('2026-11-02T09:00'), t('2026-11-02T10:00'))).toEqual({ available: true }); // ends as the next starts
    expect(checkUnit(input, 'u2', t('2026-11-02T11:00'), t('2026-11-02T13:00'))).toEqual({ available: true }); // other unit
  });

  it('buffers keep a gap of exactly `buffer` between bookings on both sides (BR-02)', () => {
    // Existing booking 10:00–12:00 with a 15-min buffer → blocked until 12:15.
    const input = {
      ...base,
      bufferMinutes: 15,
      reservations: [{ unitId: 'u1', start: t('2026-11-02T10:00'), blockedUntil: t('2026-11-02T12:15') }],
    };
    expect(checkUnit(input, 'u1', t('2026-11-02T12:10'), t('2026-11-02T13:00')).available).toBe(false);
    expect(checkUnit(input, 'u1', t('2026-11-02T12:15'), t('2026-11-02T13:00'))).toEqual({ available: true });
    // A new booking before it must end 15 min before it starts (its own buffer).
    expect(checkUnit(input, 'u1', t('2026-11-02T09:00'), t('2026-11-02T09:50')).available).toBe(false);
    expect(checkUnit(input, 'u1', t('2026-11-02T09:00'), t('2026-11-02T09:45'))).toEqual({ available: true });
  });

  it('the buffer may run past closing time', () => {
    const input = { ...base, bufferMinutes: 30 };
    expect(checkUnit(input, 'u1', t('2026-11-02T17:00'), t('2026-11-02T19:00'))).toEqual({ available: true });
  });

  it('asset-level check reports the most useful reason and the free units', () => {
    const full = {
      ...base,
      reservations: ['u1', 'u2'].map((unitId) => ({
        unitId,
        start: t('2026-11-02T10:00'),
        blockedUntil: t('2026-11-02T12:00'),
      })),
    };
    expect(assetCheck(full, t('2026-11-02T10:30'), t('2026-11-02T11:00'))).toEqual({
      available: false,
      reason: 'RESERVED',
    });
    expect(assetCheck(base, t('2026-11-02T10:30'), t('2026-11-02T11:00'))).toEqual({
      available: true,
      unitIds: ['u1', 'u2'],
    });
    expect(assetCheck({ ...base, unitIds: [] }, t('2026-11-02T10:30'), t('2026-11-02T11:00'))).toEqual({
      available: false,
      reason: 'NO_UNITS',
    });
    expect(assetCheck(base, t('2026-11-02T11:00'), t('2026-11-02T10:00'))).toEqual({
      available: false,
      reason: 'INVALID_WINDOW',
    });
  });

  it('midnight-crossing rules with reservations', () => {
    const nights = {
      ...base,
      rules: [
        { weekdays: [5], startLocal: '19:00', endLocal: '09:00', validFrom: '2026-01-01', validTo: null },
      ],
    };
    const withBooking = {
      ...nights,
      reservations: [{ unitId: 'u1', start: t('2026-11-06T22:00'), blockedUntil: t('2026-11-07T02:00') }],
    };
    expect(checkUnit(withBooking, 'u1', t('2026-11-07T02:00'), t('2026-11-07T08:00'))).toEqual({
      available: true,
    });
    expect(checkUnit(withBooking, 'u1', t('2026-11-06T20:00'), t('2026-11-07T08:00')).available).toBe(false);
    const free = freeTime(withBooking, t('2026-11-06T00:00'), t('2026-11-08T00:00')).get('u1');
    expect(free?.map((i) => `${iso(i.start)}-${iso(i.end)}`)).toEqual([
      'Fri 19:00-Fri 22:00',
      'Sat 02:00-Sat 09:00',
    ]);
  });

  it('DST: free time follows local wall-clock (Europe/London, clocks back 2026-10-25)', () => {
    const london = {
      ...base,
      timezone: 'Europe/London',
      rules: [
        { weekdays: [7], startLocal: '00:00', endLocal: '04:00', validFrom: '2026-01-01', validTo: null },
      ],
    };
    const free =
      freeTime(london, t('2026-10-25T00:00', 'Europe/London'), t('2026-10-25T12:00', 'Europe/London')).get(
        'u1',
      ) ?? [];
    expect((free[0]?.end ?? 0) - (free[0]?.start ?? 0)).toBe(5 * H); // 00:00–04:00 local spans 5 real hours that night
  });
});

describe('property outsider cap (BR-06)', () => {
  it('counts maximum simultaneous reservations, not the total overlapping', () => {
    const r = [
      { start: 9 * H, end: 10 * H },
      { start: 11 * H, end: 12 * H },
    ];
    expect(maxConcurrent(r, 8 * H, 13 * H)).toBe(1);
    expect(maxConcurrent([...r, { start: 9.5 * H, end: 10.5 * H }], 8 * H, 13 * H)).toBe(2);
    expect(maxConcurrent([{ start: 9 * H, end: 10 * H }], 10 * H, 11 * H)).toBe(0); // half-open
  });
});
