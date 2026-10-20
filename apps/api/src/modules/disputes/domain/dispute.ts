/** Disputes (domain-model §5.11, trust-and-safety §9). Pure. */
export const CATEGORIES = [
  'UNAVAILABLE_ASSET',
  'INCORRECT_LISTING',
  'ACCESS_FAILURE',
  'DAMAGE',
  'CHARGING_FAILURE',
  'BILLING',
  'NO_SHOW',
  'CANCELLATION',
  'MISCONDUCT',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const STATUSES = ['OPEN', 'UNDER_REVIEW', 'AWAITING_INFO', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;
export type Status = (typeof STATUSES)[number];
export const OUTCOMES = [
  'NO_ACTION',
  'REFUND_FULL',
  'REFUND_PARTIAL',
  'WARNING',
  'RESTRICT_ACCOUNT',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Damage and misconduct (safety, property, people) are HIGH risk: only trust & safety may resolve them. */
export const riskOf = (category: Category): 'LOW' | 'HIGH' =>
  category === 'DAMAGE' || category === 'MISCONDUCT' ? 'HIGH' : 'LOW';

/** A dispute can be opened from the booking's start until 7 days after it ends. */
export const DISPUTE_WINDOW_DAYS = 7;

export type AdminAction = 'REVIEW' | 'REQUEST_INFO' | 'ESCALATE' | 'RESOLVE' | 'CLOSE' | 'PARTY_REPLIED';
const TABLE: Record<AdminAction, Partial<Record<Status, Status>>> = {
  REVIEW: { OPEN: 'UNDER_REVIEW', AWAITING_INFO: 'UNDER_REVIEW', ESCALATED: 'UNDER_REVIEW' },
  REQUEST_INFO: { OPEN: 'AWAITING_INFO', UNDER_REVIEW: 'AWAITING_INFO', ESCALATED: 'AWAITING_INFO' },
  ESCALATE: { OPEN: 'ESCALATED', UNDER_REVIEW: 'ESCALATED', AWAITING_INFO: 'ESCALATED' },
  RESOLVE: { OPEN: 'RESOLVED', UNDER_REVIEW: 'RESOLVED', AWAITING_INFO: 'RESOLVED', ESCALATED: 'RESOLVED' },
  CLOSE: { RESOLVED: 'CLOSED' },
  PARTY_REPLIED: { AWAITING_INFO: 'UNDER_REVIEW' },
};
export function nextDisputeStatus(from: Status, action: AdminAction): Status | null {
  return TABLE[action][from] ?? null;
}
export const isOpen = (s: Status) => s !== 'RESOLVED' && s !== 'CLOSED';
