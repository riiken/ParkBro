/**
 * Access grants (domain-model §3.6, §5.7; BR-25; trust-and-safety §10). Pure. A grant authorises entry for one
 * booking, for that property and unit only, from 15 minutes before the start to 15 minutes after the end.
 */
export const EARLY_GRACE_MINUTES = 15;
export const LATE_GRACE_MINUTES = 15;
/** Access details stay visible this long after the window (receipts, "where did I park"); never for verification. */
export const REVEAL_AFTER_MS = 24 * 3_600_000;
export const GATE_TOKEN_DAYS = 90;
export const ENTRY_TICKET_MINUTES = 10;

export type StoredStatus = 'ISSUED' | 'USED' | 'REVOKED';
export type GrantStatus = 'ISSUED' | 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
export type AccessMethod = 'CODE' | 'VEHICLE_NUMBER' | 'PASS';

export function grantWindow(start: number, end: number) {
  return { from: start - EARLY_GRACE_MINUTES * 60_000, until: end + LATE_GRACE_MINUTES * 60_000 };
}

/** §5.7: ISSUED → ACTIVE (window open) → USED (first verified entry) → EXPIRED; REVOKED from any non-final state. */
export function effectiveGrantStatus(
  stored: StoredStatus,
  window: { from: number; until: number },
  at: number,
): GrantStatus {
  if (stored === 'REVOKED') return 'REVOKED';
  if (at >= window.until) return 'EXPIRED';
  if (stored === 'USED') return 'USED';
  return at >= window.from ? 'ACTIVE' : 'ISSUED';
}

/** A credential verifies only while the window is open and the grant isn't revoked (BR-25). */
export function verifies(stored: StoredStatus, window: { from: number; until: number }, at: number): boolean {
  const s = effectiveGrantStatus(stored, window, at);
  return s === 'ACTIVE' || s === 'USED';
}

/** 6-digit code from a CSPRNG integer in [0, 1e6). */
export const formatCode = (n: number) => String(n).padStart(6, '0');
