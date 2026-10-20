import { DateTime } from 'luxon';

/**
 * Booking series (domain-model §3.4, §5.4; D-014). Pure. A series is a recurring arrangement that produces one
 * ordinary booking per period on the same unit. `cadence` is the recurrence seam: the pilot builds MONTHLY only; a
 * weekday pattern (e.g. Mon–Fri 09:00–19:00) would add a cadence whose periodWindow yields one window per occurrence.
 */
export const SERIES_STATUSES = ['REQUESTED', 'ACTIVE', 'PAST_DUE', 'NOTICE_GIVEN', 'ENDED'] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];
export type SeriesCadence = 'MONTHLY';
export type SeriesEndReason =
  | 'NOT_CONFIRMED'
  | 'NOTICE'
  | 'RENEWAL_UNPAID'
  | 'UNIT_UNAVAILABLE'
  | 'HOST_CANCELLED'
  | 'CUSTOMER_CANCELLED'
  | 'PLATFORM';

export type SeriesAction =
  | 'FIRST_CONFIRMED' // period 1 paid
  | 'FIRST_FAILED' // period 1 expired, declined or cancelled before confirmation
  | 'RENEWAL_OVERDUE' // the next period started unpaid (grace begins)
  | 'RENEWAL_PAID'
  | 'NOTICE' // customer or host gives notice
  | 'END'; // notice elapsed, grace lapsed, unit unavailable, host or platform termination

const TABLE: Record<SeriesAction, Partial<Record<SeriesStatus, SeriesStatus>>> = {
  FIRST_CONFIRMED: { REQUESTED: 'ACTIVE' },
  FIRST_FAILED: { REQUESTED: 'ENDED' },
  RENEWAL_OVERDUE: { ACTIVE: 'PAST_DUE' },
  RENEWAL_PAID: { ACTIVE: 'ACTIVE', PAST_DUE: 'ACTIVE', NOTICE_GIVEN: 'NOTICE_GIVEN' },
  NOTICE: { ACTIVE: 'NOTICE_GIVEN', PAST_DUE: 'NOTICE_GIVEN' },
  END: { REQUESTED: 'ENDED', ACTIVE: 'ENDED', PAST_DUE: 'ENDED', NOTICE_GIVEN: 'ENDED' },
};

export function nextSeriesStatus(from: SeriesStatus, action: SeriesAction): SeriesStatus | null {
  return TABLE[action][from] ?? null;
}

/**
 * Period n (1-based) as [start, end) epoch ms. MONTHLY (BR-13): from the anchor's local date and time, n−1 and n
 * calendar months later. Computed from the anchor every time, so a 31st anchor gives 28/29 Feb and then 31 Mar
 * again (the anchor day is kept where it exists).
 */
export function periodWindow(
  series: { cadence: SeriesCadence; anchorStart: number; timezone: string },
  n: number,
): { start: number; end: number } {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('period index must be a positive integer');
  const anchor = DateTime.fromMillis(series.anchorStart, { zone: series.timezone });
  return {
    start: anchor.plus({ months: n - 1 }).toMillis(),
    end: anchor.plus({ months: n }).toMillis(),
  };
}

/** The period containing `at` (1 before the anchor). */
export function periodAt(
  series: { cadence: SeriesCadence; anchorStart: number; timezone: string },
  at: number,
): number {
  let n = 1;
  while (periodWindow(series, n).end <= at && n < 10_000) n += 1;
  return n;
}

/**
 * Notice (domain-model Q-2): the arrangement ends at the first period boundary at least `noticeDays` after notice
 * is given, never before the end of the period that is currently running.
 */
export function noticeEnd(
  series: { cadence: SeriesCadence; anchorStart: number; timezone: string; noticeDays: number },
  givenAt: number,
): number {
  const earliest = DateTime.fromMillis(givenAt).plus({ days: series.noticeDays }).toMillis();
  let n = periodAt(series, givenAt);
  while (periodWindow(series, n).end < earliest) n += 1;
  return periodWindow(series, n).end;
}
