/** Booking display helpers (ux-architecture C-06 … C-09). Times show in the pilot city's zone (D-097). */
export const PILOT_TIMEZONE = 'Asia/Kolkata';
const PILOT_OFFSET = '+05:30';

export interface BookingView {
  id: string;
  status: string;
  listing: { id: string; title: string; type: 'PARKING' | 'EV_CHARGING' };
  mode: string;
  start: string;
  end: string;
  vehicle: { plate: string; vehicleClass: string } | null;
  price: {
    lines: { kind: string; label: string; quantity: number; unitPricePaise: number; amountPaise: number }[];
    totalPaise: number;
  };
  holdExpiresAt: string | null;
  approvalExpiresAt: string | null;
  cancellation: {
    policy: { code: string };
    cancellable: boolean;
    refundIfCancelledNowPaise: number | null;
    cancelledBy: 'CUSTOMER' | 'HOST' | 'PLATFORM' | null;
    reason: string | null;
    refundPaise: number | null;
  };
  access: { address: string | null; unitLabel: string | null; instructions: string | null } | null;
  series: { id: string; periodIndex: number } | null;
  issue: {
    id: string;
    kind: string;
    status: 'OPEN' | 'RESOLVED_ON_SITE' | 'REFUNDED' | 'ESCALATED' | 'WITHDRAWN';
    deadlineAt: string;
    note: string | null;
  } | null;
  createdAt: string;
}

export interface PlanView {
  id: string;
  status: 'REQUESTED' | 'ACTIVE' | 'PAST_DUE' | 'NOTICE_GIVEN' | 'ENDED';
  endedReason: string | null;
  listing: { id: string; title: string };
  vehicle: { plate: string; vehicleClass: string } | null;
  customer?: { name: string };
  unitLabel?: string | null;
  anchorStart: string;
  periodPricePaise: number;
  noticeDays: number;
  graceDays: number;
  noticeBy: 'CUSTOMER' | 'HOST' | 'PLATFORM' | null;
  endsAt: string | null;
  nextRenewal: { periodIndex: number; start: string; amountPaise: number } | null;
  periods: {
    bookingId: string;
    index: number;
    status: string;
    start: string;
    end: string;
    amountPaise: number;
    payBy: string | null;
  }[];
  createdAt: string;
}

/** ux-architecture §7.4. */
export const PLAN_STATUS_LABEL: Record<PlanView['status'], string> = {
  REQUESTED: 'Requested',
  ACTIVE: 'Active',
  PAST_DUE: 'Renewal payment due',
  NOTICE_GIVEN: 'Ending',
  ENDED: 'Ended',
};

export const PLAN_END_LABEL: Record<string, string> = {
  NOT_CONFIRMED: "The first month wasn't confirmed.",
  NOTICE: 'Ended after notice.',
  RENEWAL_UNPAID: "The renewal wasn't paid in time.",
  UNIT_UNAVAILABLE: 'The space is no longer available.',
  HOST_CANCELLED: 'The host ended the plan. Any paid month is refunded in full.',
  CUSTOMER_CANCELLED: 'You withdrew the request.',
  PLATFORM: 'Ended by ParkBro.',
};

export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: PILOT_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));

export const STATUS_LABEL: Record<string, string> = {
  AWAITING_HOST_APPROVAL: 'Waiting for host',
  PENDING_PAYMENT: 'Held for payment',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: "You're parked",
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  DECLINED: 'Declined',
  NO_SHOW: 'No-show',
};

/** "2026-10-23" + "09:30" in the pilot zone → ISO instant. */
export function localToIso(date: string, time: string): string {
  return `${date}T${time}:00${PILOT_OFFSET}`;
}

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: PILOT_TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat('en-IN', {
  timeZone: PILOT_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
});

export function formatWhen(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameDay =
    s.toLocaleDateString('en-IN', { timeZone: PILOT_TIMEZONE }) ===
    e.toLocaleDateString('en-IN', { timeZone: PILOT_TIMEZONE });
  return `${dateTime.format(s)} – ${sameDay ? timeOnly.format(e) : dateTime.format(e)}`;
}

export function formatTime(iso: string): string {
  return timeOnly.format(new Date(iso));
}

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
export const formatRupees = (paise: number) => rupees.format(paise / 100);

/** YYYY-MM-DD plus n calendar days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n months, clamped to the month's last day (31 Jan + 1 → 28/29 Feb; BR-13). */
export function addMonthsClamped(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Today's date in the pilot zone, YYYY-MM-DD. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PILOT_TIMEZONE }).format(new Date());
}
