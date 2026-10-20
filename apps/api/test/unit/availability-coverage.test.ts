import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { expandRules, rulesCover, type WeeklyRule } from '../../src/modules/availability/domain/coverage.ts';

const IST = 'Asia/Kolkata';
const at = (iso: string, zone = IST) => DateTime.fromISO(iso, { zone }).toMillis();
const weekdays9to7: WeeklyRule = {
  weekdays: [1, 2, 3, 4, 5],
  startLocal: '09:00',
  endLocal: '19:00',
  validFrom: '2026-01-01',
  validTo: null,
};
const nightsFriSat: WeeklyRule = {
  weekdays: [5, 6],
  startLocal: '19:00',
  endLocal: '09:00',
  validFrom: '2026-01-01',
  validTo: null,
};
const allDay: WeeklyRule = {
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  startLocal: '00:00',
  endLocal: '00:00',
  validFrom: '2026-01-01',
  validTo: null,
};

// 2026-11-02 is a Monday.
describe('rule coverage (BR-01 rules, BR-03)', () => {
  it('covers a window inside a weekday rule, in the property timezone', () => {
    expect(rulesCover([weekdays9to7], at('2026-11-02T10:00'), at('2026-11-02T12:00'), IST)).toBe(true);
    expect(rulesCover([weekdays9to7], at('2026-11-02T08:30'), at('2026-11-02T10:00'), IST)).toBe(false);
    expect(rulesCover([weekdays9to7], at('2026-11-02T18:00'), at('2026-11-02T19:00'), IST)).toBe(true); // end exclusive
    expect(rulesCover([weekdays9to7], at('2026-11-02T18:00'), at('2026-11-02T19:01'), IST)).toBe(false);
    expect(rulesCover([weekdays9to7], at('2026-11-07T10:00'), at('2026-11-07T11:00'), IST)).toBe(false); // Saturday
  });

  it('is evaluated in local time, not UTC (10:00 IST = 04:30 UTC)', () => {
    const utcInstant = Date.UTC(2026, 10, 2, 4, 30); // 2026-11-02T04:30Z
    expect(rulesCover([weekdays9to7], utcInstant, utcInstant + 3_600_000, IST)).toBe(true);
    expect(rulesCover([weekdays9to7], utcInstant, utcInstant + 3_600_000, 'UTC')).toBe(false); // 04:30 local in UTC
  });

  it('handles windows that cross midnight, including one opened the previous local day', () => {
    // Friday 2026-11-06 19:00 → Saturday 09:00, and Saturday 19:00 → Sunday 09:00.
    expect(rulesCover([nightsFriSat], at('2026-11-06T22:00'), at('2026-11-07T08:00'), IST)).toBe(true);
    expect(rulesCover([nightsFriSat], at('2026-11-07T02:00'), at('2026-11-07T03:00'), IST)).toBe(true);
    expect(rulesCover([nightsFriSat], at('2026-11-07T08:00'), at('2026-11-07T10:00'), IST)).toBe(false);
    expect(rulesCover([nightsFriSat], at('2026-11-08T08:00'), at('2026-11-08T09:00'), IST)).toBe(true); // Sat-night window
  });

  it('merges adjacent rules into one contiguous period, so a window can span them', () => {
    const morning: WeeklyRule = { ...weekdays9to7, startLocal: '06:00', endLocal: '09:00' };
    expect(rulesCover([weekdays9to7], at('2026-11-02T07:00'), at('2026-11-02T10:00'), IST)).toBe(false);
    expect(rulesCover([weekdays9to7, morning], at('2026-11-02T07:00'), at('2026-11-02T10:00'), IST)).toBe(
      true,
    );
  });

  it('equal start and end means the full day; consecutive full days merge for multi-day and monthly windows', () => {
    expect(rulesCover([allDay], at('2026-11-02T00:00'), at('2026-12-02T00:00'), IST)).toBe(true);
    const weekdaysOnlyAllDay = { ...allDay, weekdays: [1, 2, 3, 4, 5] };
    expect(rulesCover([weekdaysOnlyAllDay], at('2026-11-02T00:00'), at('2026-11-09T00:00'), IST)).toBe(false); // weekend gap
  });

  it('respects validFrom / validTo (inclusive local dates)', () => {
    const november: WeeklyRule = { ...allDay, validFrom: '2026-11-01', validTo: '2026-11-30' };
    expect(rulesCover([november], at('2026-11-30T10:00'), at('2026-11-30T11:00'), IST)).toBe(true);
    expect(rulesCover([november], at('2026-12-01T10:00'), at('2026-12-01T11:00'), IST)).toBe(false);
    expect(rulesCover([november], at('2026-10-31T10:00'), at('2026-10-31T11:00'), IST)).toBe(false);
  });

  it('is DST-correct: a 09:00–17:00 rule stays 09:00–17:00 local across a clock change', () => {
    const london: WeeklyRule = {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startLocal: '09:00',
      endLocal: '17:00',
      validFrom: '2026-01-01',
      validTo: null,
    };
    // UK clocks go back on 2026-10-25 (BST → GMT).
    const before = expandRules(
      [london],
      at('2026-10-24T00:00', 'Europe/London'),
      at('2026-10-25T00:00', 'Europe/London'),
      'Europe/London',
    );
    const after = expandRules(
      [london],
      at('2026-10-26T00:00', 'Europe/London'),
      at('2026-10-27T00:00', 'Europe/London'),
      'Europe/London',
    );
    expect(new Date(before[0]?.start ?? 0).toISOString()).toBe('2026-10-24T08:00:00.000Z'); // 09:00 BST
    expect(new Date(after[0]?.start ?? 0).toISOString()).toBe('2026-10-26T09:00:00.000Z'); // 09:00 GMT
    // The night of the change: a 00:00–00:00 rule on 2026-10-25 lasts 25 hours.
    const day = expandRules(
      [{ ...london, startLocal: '00:00', endLocal: '00:00' }],
      at('2026-10-25T00:00', 'Europe/London'),
      at('2026-10-25T23:00', 'Europe/London'),
      'Europe/London',
    );
    expect(day.some((i) => i.end - i.start === 25 * 3_600_000)).toBe(true);
  });

  it('rejects empty or inverted windows and handles no rules', () => {
    expect(rulesCover([allDay], at('2026-11-02T10:00'), at('2026-11-02T10:00'), IST)).toBe(false);
    expect(rulesCover([allDay], at('2026-11-02T11:00'), at('2026-11-02T10:00'), IST)).toBe(false);
    expect(rulesCover([], at('2026-11-02T10:00'), at('2026-11-02T11:00'), IST)).toBe(false);
  });
});
