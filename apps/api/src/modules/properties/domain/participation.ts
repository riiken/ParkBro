/** Property participation lifecycle (domain-model §5.2). Anything not listed is rejected. */
export const PARTICIPATION_STATUSES = [
  'NOT_REQUIRED',
  'CONSENT_REQUIRED',
  'PENDING_CONSENT',
  'PARTICIPATING',
  'SUSPENDED',
  'WITHDRAWN',
] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];

const TRANSITIONS: Record<ParticipationStatus, readonly ParticipationStatus[]> = {
  NOT_REQUIRED: [],
  CONSENT_REQUIRED: ['PENDING_CONSENT'],
  PENDING_CONSENT: ['PARTICIPATING', 'CONSENT_REQUIRED'],
  PARTICIPATING: ['SUSPENDED', 'WITHDRAWN'],
  SUSPENDED: ['PARTICIPATING', 'WITHDRAWN'],
  // Re-onboarding after withdrawal restarts consent (refinement of §5.2, decision log D-066).
  WITHDRAWN: ['PENDING_CONSENT'],
};

export function canTransitionParticipation(from: ParticipationStatus, to: ParticipationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses in which the property's listings must stop taking bookings (assets are suspended). */
export function participationHaltsListings(status: ParticipationStatus): boolean {
  return status === 'SUSPENDED' || status === 'WITHDRAWN';
}
