import { DateTime } from 'luxon';

/**
 * Weekly-rule expansion and window coverage (BR-01 rule part, BR-03). Pure and timezone-correct: rules are
 * wall-clock times in the property's IANA timezone, expanded per local calendar date (never by adding fixed
 * offsets), so DST and midnight-crossing windows behave. Phase 11 adds exceptions, blocks and bookings on top.
 */
export interface WeeklyRule {
  weekdays: readonly number[]; // ISO 1 = Monday … 7 = Sunday
  startLocal: string; // HH:MM
  endLocal: string; // HH:MM; end <= start crosses midnight; equal = 24 h
  validFrom: string; // YYYY-MM-DD (local date)
  validTo: string | null;
}

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms, exclusive
}

function parseHm(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/** All open intervals from `rules` that intersect [from, to), merged and sorted. */
export function expandRules(
  rules: readonly WeeklyRule[],
  from: number,
  to: number,
  timezone: string,
): Interval[] {
  if (to <= from) return [];
  const intervals: Interval[] = [];
  // Start one local day early: a window that crosses midnight may have opened the day before `from`.
  let day = DateTime.fromMillis(from, { zone: timezone }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromMillis(to, { zone: timezone }).startOf('day');

  while (day <= lastDay) {
    const date = day.toISODate() ?? '';
    for (const rule of rules) {
      if (date < rule.validFrom || (rule.validTo !== null && date > rule.validTo)) continue;
      if (!rule.weekdays.includes(day.weekday)) continue;
      const s = parseHm(rule.startLocal);
      const e = parseHm(rule.endLocal);
      const start = day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
      const crossesMidnight = e.hour * 60 + e.minute <= s.hour * 60 + s.minute;
      const endDay = crossesMidnight ? day.plus({ days: 1 }) : day;
      const end = endDay.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
      const interval = { start: start.toMillis(), end: end.toMillis() };
      if (interval.end > from && interval.start < to && interval.end > interval.start)
        intervals.push(interval);
    }
    day = day.plus({ days: 1 });
  }
  return merge(intervals);
}

export function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

/** True if a single contiguous open period covers the whole of [start, end). */
export function rulesCover(
  rules: readonly WeeklyRule[],
  start: number,
  end: number,
  timezone: string,
): boolean {
  if (end <= start) return false;
  return expandRules(rules, start, end, timezone).some((i) => i.start <= start && i.end >= end);
}
