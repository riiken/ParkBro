/**
 * Charging session (domain-model §5.9). Pure. A session is the charging part of an EV_CHARGING booking; the booking
 * decides *whether* the customer may use the bay, the session records *what happened* at the charger.
 */
export const SESSION_STATUSES = ['NOT_STARTED', 'CHARGING', 'COMPLETED', 'STOPPED_EARLY', 'FAULTED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type SessionAction = 'START' | 'STOP' | 'COMPLETE' | 'FAULT';
export const FAULT_REASONS = [
  'NOT_WORKING',
  'CONNECTOR_DAMAGED',
  'NO_POWER',
  'CANNOT_REACH',
  'OTHER',
] as const;
export type FaultReason = (typeof FAULT_REASONS)[number];

const TABLE: Record<SessionAction, Partial<Record<SessionStatus, SessionStatus>>> = {
  START: { NOT_STARTED: 'CHARGING' },
  STOP: { CHARGING: 'STOPPED_EARLY' }, // customer stops before the booking ends
  COMPLETE: { CHARGING: 'COMPLETED' }, // booking end, or a stop at/after the end
  FAULT: { NOT_STARTED: 'FAULTED', CHARGING: 'FAULTED' },
};

export function nextSessionStatus(from: SessionStatus, action: SessionAction): SessionStatus | null {
  return TABLE[action][from] ?? null;
}

/** Customers may plug in a little before the window (arrival) but never after it ends. */
export const START_EARLY_MINUTES = 15;

export function canStartAt(window: { start: number; end: number }, at: number): boolean {
  return at >= window.start - START_EARLY_MINUTES * 60_000 && at < window.end;
}

/**
 * Charging speed class shown to customers (ux §4.4). Thresholds follow common Indian usage: 15A sockets and small
 * AC wallboxes are slow, 7–22 kW AC is fast, DC is rapid.
 */
export type SpeedClass = 'SLOW' | 'FAST' | 'RAPID';
export function speedClass(currentType: 'AC' | 'DC', powerKw: number): SpeedClass {
  if (currentType === 'DC') return 'RAPID';
  return powerKw >= 7 ? 'FAST' : 'SLOW';
}

/**
 * Energy a charger could deliver in `minutes` at its rated power, in kWh, rounded down to 0.5. An upper bound for
 * the customer's planning only: real delivery depends on the car (onboard charger, battery state, temperature).
 */
export function maxEnergyKwh(powerKw: number, minutes: number): number {
  return Math.floor(((powerKw * minutes) / 60) * 2) / 2;
}
