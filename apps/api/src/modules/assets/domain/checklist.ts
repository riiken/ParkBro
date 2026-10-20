/**
 * Publish preconditions (domain-model §5.1, trust-and-safety §4.2). Pure: computed from a snapshot.
 * Deferred until their phases exist: payout account (Phase 16) and KYC for first payout (trust §4.2).
 */
export type ChecklistItem =
  | 'PARKING_DETAILS'
  | 'CHARGER_DETAILS'
  | 'UNITS'
  | 'PHOTO_SLOT'
  | 'PHOTO_CHARGER'
  | 'RATE'
  | 'AVAILABILITY'
  | 'ATTESTATION_RIGHT_TO_RENT'
  | 'ATTESTATION_CHARGER_SAFETY'
  | 'SOCIETY_NOT_PARTICIPATING'
  | 'NOT_A_MEMBER'
  | 'HOST_NOT_ACTIVE';

export interface ChecklistSnapshot {
  assetType: 'PARKING' | 'EV_CHARGING';
  requiredMediaKinds: readonly string[];
  requiredAttestations: readonly string[];
  hasParkingDetails: boolean;
  hasChargerDetails: boolean;
  activeUnits: number;
  mediaKinds: readonly string[]; // non-removed, non-rejected media
  rateModes: readonly string[];
  availabilityRules: number;
  attestationStatuses: Readonly<Record<string, string | undefined>>;
  listing: { canPublish: boolean } | null; // null: the host is no longer linked to the property
  hostActive: boolean;
}

export function publishChecklist(s: ChecklistSnapshot): { ready: boolean; missing: ChecklistItem[] } {
  const missing: ChecklistItem[] = [];
  if (!s.hasParkingDetails) missing.push('PARKING_DETAILS');
  if (s.assetType === 'EV_CHARGING' && !s.hasChargerDetails) missing.push('CHARGER_DETAILS');
  if (s.activeUnits < 1) missing.push('UNITS');
  for (const kind of s.requiredMediaKinds) {
    if (!s.mediaKinds.includes(kind)) missing.push(`PHOTO_${kind}` as ChecklistItem);
  }
  if (s.rateModes.length === 0) missing.push('RATE');
  if (s.availabilityRules === 0) missing.push('AVAILABILITY');
  for (const kind of s.requiredAttestations) {
    const status = s.attestationStatuses[kind];
    if (status !== 'ATTESTED' && status !== 'VERIFIED') missing.push(`ATTESTATION_${kind}` as ChecklistItem);
  }
  if (s.listing === null) missing.push('NOT_A_MEMBER');
  else if (!s.listing.canPublish) missing.push('SOCIETY_NOT_PARTICIPATING');
  if (!s.hostActive) missing.push('HOST_NOT_ACTIVE');
  return { ready: missing.length === 0, missing };
}
