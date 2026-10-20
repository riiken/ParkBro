/** Booking lifecycle (domain-model §5.3, D-015). Pure; anything not listed is rejected. */
export const BOOKING_STATUSES = [
  'AWAITING_HOST_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'DECLINED',
  'NO_SHOW',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type BookingAction =
  | 'HOST_APPROVE' // AWAITING_HOST_APPROVAL → PENDING_PAYMENT
  | 'HOST_DECLINE' // AWAITING_HOST_APPROVAL → DECLINED
  | 'EXPIRE' // lapsed approval window or payment hold → EXPIRED
  | 'PAYMENT_SUCCEEDED' // PENDING_PAYMENT → CONFIRMED (verified provider event only, Phase 15)
  | 'CHECK_IN' // CONFIRMED → IN_PROGRESS (Phase 17 access) / monthly period start
  | 'COMPLETE' // IN_PROGRESS → COMPLETED; CONFIRMED (monthly, no check-in needed) → COMPLETED
  | 'NO_SHOW' // CONFIRMED at start + grace without entry (short-term)
  | 'CANCEL'; // customer, host or platform

const TABLE: Record<BookingAction, Partial<Record<BookingStatus, BookingStatus>>> = {
  HOST_APPROVE: { AWAITING_HOST_APPROVAL: 'PENDING_PAYMENT' },
  HOST_DECLINE: { AWAITING_HOST_APPROVAL: 'DECLINED' },
  EXPIRE: { AWAITING_HOST_APPROVAL: 'EXPIRED', PENDING_PAYMENT: 'EXPIRED' },
  PAYMENT_SUCCEEDED: { PENDING_PAYMENT: 'CONFIRMED' },
  CHECK_IN: { CONFIRMED: 'IN_PROGRESS' },
  COMPLETE: { IN_PROGRESS: 'COMPLETED', CONFIRMED: 'COMPLETED' },
  NO_SHOW: { CONFIRMED: 'NO_SHOW' },
  CANCEL: {
    AWAITING_HOST_APPROVAL: 'CANCELLED',
    PENDING_PAYMENT: 'CANCELLED',
    CONFIRMED: 'CANCELLED',
    IN_PROGRESS: 'CANCELLED', // recourse (BR-24) only; customers can't cancel mid-booking themselves
  },
};

export function nextStatus(from: BookingStatus, action: BookingAction): BookingStatus | null {
  return TABLE[action][from] ?? null;
}

export const HOLDING_STATUSES: readonly BookingStatus[] = [
  'AWAITING_HOST_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'IN_PROGRESS',
];
export const TERMINAL_STATUSES: readonly BookingStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'DECLINED',
  'NO_SHOW',
];
