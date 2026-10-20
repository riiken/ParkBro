/** Host-side types and copy (ux-architecture §7.8, §9). */
export interface HostAccount {
  hostAccountId: string;
  role: 'OWNER' | 'MANAGER';
  status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED';
  kind: 'INDIVIDUAL' | 'BUSINESS';
  displayName: string;
}

export interface HostProperty {
  id: string;
  kind: string;
  displayName: string | null;
  relation: 'OWNER' | 'MEMBER_HOST';
  address: string;
  areaLabel: string;
  participationStatus: string;
}

export interface HostAssetSummary {
  id: string;
  propertyId: string;
  type: 'PARKING' | 'EV_CHARGING';
  status: string;
  title: string;
  needsReview: boolean;
  ready: boolean;
  missing: string[];
}

export interface ParkingDetails {
  covered: boolean;
  level: string;
  maxVehicleClass: string;
  heightCm: number | null;
  lengthCm: number | null;
  security: string[];
  lighting: boolean;
  evReadySocket: boolean;
  tandem: boolean;
}

export interface ChargerDetails {
  connectors: string[];
  currentType: 'AC' | 'DC';
  powerKw: number;
  cableProvided: boolean;
  connectionType: 'DOMESTIC' | 'EV_METERED' | 'COMMERCIAL';
}

export interface HostAsset {
  id: string;
  propertyId: string;
  type: 'PARKING' | 'EV_CHARGING';
  status: string;
  needsReview: boolean;
  statusReason: string | null;
  title: string;
  description: string;
  rulesText: string;
  accessInstructions: string | null;
  approvalRequired: boolean;
  bufferMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  leadMinutes: number;
  cancellationPolicy: 'FLEXIBLE' | 'MODERATE' | 'STRICT';
  version: number;
  parkingDetails: ParkingDetails | null;
  chargerDetails: ChargerDetails | null;
  units: { id: string; label: string; status: string }[];
  media: { id: string; kind: string; moderationStatus: string; width: number; height: number; url: string }[];
  rates: {
    mode: string;
    unit: string;
    pricePaise: number;
    overnightStart?: string | null;
    overnightEnd?: string | null;
  }[];
  availabilityRules: { id: string; weekdays: number[]; startLocal: string; endLocal: string }[];
  attestations: Record<string, { status: string | null; statement: { version: string; text: string } }>;
  checklist: { ready: boolean; missing: string[] };
}

export interface HostBooking {
  id: string;
  status: string;
  listing: { id: string; title: string };
  unitLabel: string | null;
  mode: string;
  start: string;
  end: string;
  customer: { name: string };
  vehicle: { plate: string; vehicleClass: string; isEv: boolean } | null;
  totalPaise: number;
  approvalExpiresAt: string | null;
  cancelledBy: string | null;
  series: { id: string; periodIndex: number } | null;
  issue: { id: string; kind: string; status: string; deadlineAt: string; note: string | null } | null;
  canReportNoShow: boolean;
  createdAt: string;
}

export const ASSET_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'In review',
  PUBLISHED: 'Live',
  PAUSED: 'Paused',
  SUSPENDED: 'Suspended',
  ARCHIVED: 'Archived',
};

export const ASSET_STATUS_HINT: Record<string, string> = {
  DRAFT: 'Finish the steps below, then submit for review.',
  PENDING_REVIEW: 'In review: usually within 24 hours. You can still edit private details.',
  PUBLISHED: 'Live: customers can find and book it.',
  PAUSED: 'Paused: not taking new bookings. Existing bookings go ahead.',
  SUSPENDED: 'Suspended by ParkBro. Contact support.',
  ARCHIVED: 'Archived.',
};

/** What a listing still needs before it can be submitted (domain/checklist.ts). */
export const CHECKLIST_LABEL: Record<string, string> = {
  PARKING_DETAILS: 'Describe the space',
  CHARGER_DETAILS: 'Describe the charger',
  UNITS: 'Add at least one space',
  PHOTO_SLOT: 'Add a photo of the space',
  PHOTO_CHARGER: 'Add a photo of the charger',
  RATE: 'Set at least one price',
  AVAILABILITY: 'Set when it is available',
  ATTESTATION_RIGHT_TO_RENT: 'Confirm you have the right to rent it',
  ATTESTATION_CHARGER_SAFETY: 'Confirm the charger safety statement',
  SOCIETY_NOT_PARTICIPATING: 'Your society has not joined ParkBro yet',
  NOT_A_MEMBER: 'Your society has not approved you as a host',
  HOST_NOT_ACTIVE: 'Your host account is restricted',
};

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekly schedule presets (H-02 step 6). */
export const SCHEDULE_PRESETS: {
  id: string;
  label: string;
  rules: { weekdays: number[]; startLocal: string; endLocal: string }[];
}[] = [
  {
    id: 'always',
    label: 'Always (24/7)',
    rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '00:00' }],
  },
  {
    id: 'weekdays',
    label: 'Weekdays 9:00–19:00',
    rules: [{ weekdays: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '19:00' }],
  },
  {
    id: 'nights',
    label: 'Every night 19:00–09:00',
    rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '19:00', endLocal: '09:00' }],
  },
];

/** Raw image upload (not JSON): same-origin, CSRF header, typed problem errors. */
export async function uploadPhoto(assetId: string, kind: string, file: File): Promise<HostAsset> {
  const res = await fetch(`/api/v1/host/assets/${encodeURIComponent(assetId)}/media?kind=${kind}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'fetch',
      'content-type': file.type || 'application/octet-stream',
      accept: 'application/json',
    },
    body: file,
  });
  const data = (await res.json().catch(() => null)) as
    (HostAsset & { title?: string; detail?: string }) | null;
  if (!res.ok)
    throw new Error(data?.detail ? `${data.title}. ${data.detail}` : (data?.title ?? 'Upload failed.'));
  return data as HostAsset;
}
