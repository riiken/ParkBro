import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  nextSeriesStatus,
  noticeEnd,
  periodAt,
  periodWindow,
} from '../../src/modules/booking/domain/series.ts';

const IST = 'Asia/Kolkata';
const ms = (iso: string) => DateTime.fromISO(iso, { zone: IST }).toMillis();
const iso = (t: number) => DateTime.fromMillis(t, { zone: IST }).toFormat("yyyy-MM-dd'T'HH:mm");
const series = (anchor: string) => ({
  cadence: 'MONTHLY' as const,
  anchorStart: ms(anchor),
  timezone: IST,
  noticeDays: 15,
});

describe('periodWindow (BR-13)', () => {
  it('runs calendar months from the anchor in local time', () => {
    const s = series('2026-11-05T08:00');
    expect([1, 2, 3].map((n) => periodWindow(s, n)).map((w) => `${iso(w.start)}→${iso(w.end)}`)).toEqual([
      '2026-11-05T08:00→2026-12-05T08:00',
      '2026-12-05T08:00→2027-01-05T08:00',
      '2027-01-05T08:00→2027-02-05T08:00',
    ]);
  });

  it('clamps to the month end and keeps the anchor day afterwards', () => {
    const s = series('2027-01-31T00:00');
    expect([1, 2, 3, 4].map((n) => iso(periodWindow(s, n).start))).toEqual([
      '2027-01-31T00:00',
      '2027-02-28T00:00',
      '2027-03-31T00:00',
      '2027-04-30T00:00',
    ]);
    expect(iso(periodWindow(series('2028-01-31T00:00'), 2).start)).toBe('2028-02-29T00:00'); // leap year
  });

  it('periods are contiguous and the index must be positive', () => {
    const s = series('2027-01-31T09:30');
    for (let n = 1; n < 24; n += 1) expect(periodWindow(s, n).end).toBe(periodWindow(s, n + 1).start);
    expect(() => periodWindow(s, 0)).toThrow(RangeError);
    expect(() => periodWindow(s, 1.5)).toThrow(RangeError);
  });

  it('keeps local wall time across a DST zone', () => {
    const s = {
      cadence: 'MONTHLY' as const,
      anchorStart: DateTime.fromISO('2027-02-20T09:00', { zone: 'Europe/London' }).toMillis(),
      timezone: 'Europe/London',
    };
    const w = periodWindow(s, 2);
    expect(DateTime.fromMillis(w.start, { zone: 'Europe/London' }).toFormat('MM-dd HH:mm')).toBe(
      '03-20 09:00',
    );
    expect(
      DateTime.fromMillis(periodWindow(s, 3).start, { zone: 'Europe/London' }).toFormat('MM-dd HH:mm'),
    ).toBe('04-20 09:00');
  });
});

describe('periodAt and noticeEnd (Q-2)', () => {
  const s = series('2026-11-05T08:00');
  it('finds the running period', () => {
    expect(periodAt(s, ms('2026-11-01T00:00'))).toBe(1);
    expect(periodAt(s, ms('2026-11-20T00:00'))).toBe(1);
    expect(periodAt(s, ms('2026-12-05T08:00'))).toBe(2);
  });
  it('ends at the first period boundary at least the notice period away', () => {
    expect(iso(noticeEnd(s, ms('2026-11-10T00:00')))).toBe('2026-12-05T08:00'); // 25 days left ≥ 15
    expect(iso(noticeEnd(s, ms('2026-11-25T00:00')))).toBe('2027-01-05T08:00'); // 10 days left < 15
    expect(iso(noticeEnd(s, ms('2026-11-20T08:00')))).toBe('2026-12-05T08:00'); // exactly 15 days
    expect(iso(noticeEnd({ ...s, noticeDays: 0 }, ms('2026-12-06T00:00')))).toBe('2027-01-05T08:00');
  });
});

describe('series state machine (§5.4)', () => {
  it('allows only the defined transitions', () => {
    expect(nextSeriesStatus('REQUESTED', 'FIRST_CONFIRMED')).toBe('ACTIVE');
    expect(nextSeriesStatus('REQUESTED', 'FIRST_FAILED')).toBe('ENDED');
    expect(nextSeriesStatus('ACTIVE', 'RENEWAL_OVERDUE')).toBe('PAST_DUE');
    expect(nextSeriesStatus('PAST_DUE', 'RENEWAL_PAID')).toBe('ACTIVE');
    expect(nextSeriesStatus('NOTICE_GIVEN', 'RENEWAL_PAID')).toBe('NOTICE_GIVEN');
    expect(nextSeriesStatus('ACTIVE', 'NOTICE')).toBe('NOTICE_GIVEN');
    expect(nextSeriesStatus('NOTICE_GIVEN', 'NOTICE')).toBeNull();
    expect(nextSeriesStatus('REQUESTED', 'NOTICE')).toBeNull();
    expect(nextSeriesStatus('ENDED', 'END')).toBeNull();
    expect(nextSeriesStatus('ENDED', 'RENEWAL_PAID')).toBeNull();
    expect(nextSeriesStatus('ACTIVE', 'FIRST_CONFIRMED')).toBeNull();
  });
});
