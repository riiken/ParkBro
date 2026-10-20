/**
 * Asset lifecycle (domain-model §5.1, D-015). Pure: every allowed (status, action) pair is listed;
 * anything else is rejected.
 */
export const ASSET_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export type AssetAction =
  | 'SUBMIT' // host: DRAFT → PENDING_REVIEW
  | 'APPROVE' // admin
  | 'REJECT' // admin, back to DRAFT with a reason
  | 'PAUSE' // host unpublishes
  | 'REPUBLISH' // host
  | 'MATERIAL_CHANGE' // location or photos changed (BR-23)
  | 'SUSPEND' // admin, or system (society participation halted, membership revoked)
  | 'REINSTATE' // admin: SUSPENDED → PAUSED (host republishes)
  | 'ARCHIVE'; // host

export interface TransitionResult {
  to: AssetStatus;
  needsReview: boolean;
}

export function transition(
  from: AssetStatus,
  action: AssetAction,
  state: { needsReview: boolean },
): TransitionResult | null {
  switch (action) {
    case 'SUBMIT':
      return from === 'DRAFT' ? { to: 'PENDING_REVIEW', needsReview: false } : null;
    case 'APPROVE':
      return from === 'PENDING_REVIEW' ? { to: 'PUBLISHED', needsReview: false } : null;
    case 'REJECT':
      return from === 'PENDING_REVIEW' ? { to: 'DRAFT', needsReview: false } : null;
    case 'PAUSE':
      return from === 'PUBLISHED' ? { to: 'PAUSED', needsReview: state.needsReview } : null;
    case 'REPUBLISH':
      if (from !== 'PAUSED') return null;
      return state.needsReview
        ? { to: 'PENDING_REVIEW', needsReview: false }
        : { to: 'PUBLISHED', needsReview: false };
    case 'MATERIAL_CHANGE':
      if (from === 'PUBLISHED') return { to: 'PENDING_REVIEW', needsReview: false };
      if (from === 'PAUSED' || from === 'SUSPENDED') return { to: from, needsReview: true };
      if (from === 'DRAFT' || from === 'PENDING_REVIEW') return { to: from, needsReview: false };
      return null;
    case 'SUSPEND':
      return from === 'ARCHIVED' || from === 'SUSPENDED'
        ? null
        : { to: 'SUSPENDED', needsReview: state.needsReview };
    case 'REINSTATE':
      return from === 'SUSPENDED' ? { to: 'PAUSED', needsReview: state.needsReview } : null;
    case 'ARCHIVE':
      // No future bookings exist before Phase 12; the booking check is added there (domain-model §5.1).
      return from === 'DRAFT' || from === 'PAUSED' ? { to: 'ARCHIVED', needsReview: false } : null;
  }
}

/** Statuses in which host edits are allowed. */
export function isEditable(status: AssetStatus): boolean {
  return status !== 'ARCHIVED';
}
