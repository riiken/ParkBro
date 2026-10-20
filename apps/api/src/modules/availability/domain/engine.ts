import { expandRules, merge, type Interval, type WeeklyRule } from './coverage.ts';

/**
 * Deterministic availability engine (domain-model BR-01 to BR-06; CLAUDE.md §13: availability comes from
 * application state, never from an LLM). Pure: callers load the inputs; this computes.
 *
 * Free time of a unit over [from, to) =
 *     (weekly rules ∪ OPEN exceptions for the asset or the unit)
 *   − BLOCK exceptions for the asset or the unit
 *   − holding reservations of the unit (each already covers [start, end + its buffer), BR-02).
 * All intervals are half-open [start, end) in epoch ms.
 */
export interface AvailabilityException {
  id: string;
  unitId: string | null; // null = applies to every unit of the asset
  kind: 'BLOCK' | 'OPEN';
  start: number;
  end: number;
}

export interface Reservation {
  unitId: string;
  /** Start of the booking. */
  start: number;
  /** End of the booking's blocked period: booking end + the buffer snapshotted on that booking. */
  blockedUntil: number;
}

export interface AssetAvailabilityInput {
  timezone: string;
  bufferMinutes: number;
  unitIds: readonly string[];
  rules: readonly WeeklyRule[];
  exceptions: readonly AvailabilityException[];
  reservations: readonly Reservation[];
}

export function clip(intervals: readonly Interval[], from: number, to: number): Interval[] {
  return intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start);
}

/** a − b for sorted, merged interval lists. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const holes = merge([...b]);
  const out: Interval[] = [];
  for (const interval of a) {
    let cursor = interval.start;
    for (const hole of holes) {
      if (hole.end <= cursor || hole.start >= interval.end) continue;
      if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= interval.end) break;
    }
    if (cursor < interval.end) out.push({ start: cursor, end: interval.end });
  }
  return out;
}

/** The asset's open schedule for one unit, before reservations. */
function openTime(input: AssetAvailabilityInput, unitId: string, from: number, to: number): Interval[] {
  const applies = (e: AvailabilityException) => e.unitId === null || e.unitId === unitId;
  const opens = input.exceptions
    .filter((e) => e.kind === 'OPEN' && applies(e))
    .map(({ start, end }) => ({ start, end }));
  const blocks = input.exceptions
    .filter((e) => e.kind === 'BLOCK' && applies(e))
    .map(({ start, end }) => ({ start, end }));
  const scheduled = merge([...expandRules(input.rules, from, to, input.timezone), ...clip(opens, from, to)]);
  return clip(subtract(scheduled, blocks), from, to);
}

function reservedFor(input: AssetAvailabilityInput, unitId: string): Interval[] {
  return merge(
    input.reservations
      .filter((r) => r.unitId === unitId)
      .map((r) => ({ start: r.start, end: r.blockedUntil })),
  );
}

/** Free intervals per unit within [from, to). */
export function freeTime(input: AssetAvailabilityInput, from: number, to: number): Map<string, Interval[]> {
  const result = new Map<string, Interval[]>();
  for (const unitId of input.unitIds) {
    result.set(unitId, subtract(openTime(input, unitId, from, to), reservedFor(input, unitId)));
  }
  return result;
}

export type UnavailableReason = 'CLOSED' | 'BLOCKED' | 'RESERVED' | 'NO_UNITS' | 'INVALID_WINDOW';

/**
 * Can `unitId` take a booking for [start, end)? The window must lie inside open time, and the window plus this
 * asset's buffer after it must not overlap any existing reservation (BR-02: the gap between bookings is the buffer).
 * The buffer itself may extend past closing time (turnover happens regardless of opening hours).
 */
export function checkUnit(
  input: AssetAvailabilityInput,
  unitId: string,
  start: number,
  end: number,
): { available: true } | { available: false; reason: UnavailableReason } {
  if (end <= start) return { available: false, reason: 'INVALID_WINDOW' };
  const open = openTime(input, unitId, start, end);
  const covered = open.some((i) => i.start <= start && i.end >= end);
  if (!covered) {
    // Distinguish "host blocked it" from "outside the schedule" for clearer UX.
    const withoutBlocks = openTime(
      { ...input, exceptions: input.exceptions.filter((e) => e.kind === 'OPEN') },
      unitId,
      start,
      end,
    );
    const wouldBeOpen = withoutBlocks.some((i) => i.start <= start && i.end >= end);
    return { available: false, reason: wouldBeOpen ? 'BLOCKED' : 'CLOSED' };
  }
  const needed = { start, end: end + input.bufferMinutes * 60_000 };
  const clash = reservedFor(input, unitId).some((r) => r.start < needed.end && r.end > needed.start);
  return clash ? { available: false, reason: 'RESERVED' } : { available: true };
}

/** BR-05: units free for the whole window, in a deterministic order (the input order: label order). */
export function availableUnits(input: AssetAvailabilityInput, start: number, end: number): string[] {
  return input.unitIds.filter((unitId) => checkUnit(input, unitId, start, end).available);
}

/**
 * Why the asset as a whole can't take [start, end): the "best" reason across units, so a fully booked lot says
 * RESERVED rather than CLOSED.
 */
export function assetCheck(
  input: AssetAvailabilityInput,
  start: number,
  end: number,
): { available: true; unitIds: string[] } | { available: false; reason: UnavailableReason } {
  if (end <= start) return { available: false, reason: 'INVALID_WINDOW' };
  if (input.unitIds.length === 0) return { available: false, reason: 'NO_UNITS' };
  const unitIds = availableUnits(input, start, end);
  if (unitIds.length > 0) return { available: true, unitIds };
  const reasons = input.unitIds.map((u) => {
    const r = checkUnit(input, u, start, end);
    return r.available ? 'RESERVED' : r.reason;
  });
  const priority: UnavailableReason[] = ['RESERVED', 'BLOCKED', 'CLOSED'];
  return { available: false, reason: priority.find((p) => reasons.includes(p)) ?? 'CLOSED' };
}

/**
 * BR-06: the maximum number of simultaneously holding reservations over [start, end) (sweep over start points),
 * used to enforce a property's outsider cap across all its assets. Matches booking.max_concurrent_in_property in
 * the Phase 6 prototype (database-design §6.3).
 */
export function maxConcurrent(
  reservations: readonly { start: number; end: number }[],
  start: number,
  end: number,
): number {
  const overlapping = reservations.filter((r) => r.start < end && r.end > start);
  const points = [start, ...overlapping.map((r) => Math.max(r.start, start))];
  let max = 0;
  for (const t of points) {
    const count = overlapping.filter((r) => r.start <= t && r.end > t).length;
    if (count > max) max = count;
  }
  return max;
}
