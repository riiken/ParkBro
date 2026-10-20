/** Payment and refund states (domain-model §5.5). Pure. */
export const PAYMENT_STATUSES = ['CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const REFUND_STATUSES = ['PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export type RefundReason =
  | 'CUSTOMER_CANCELLED'
  | 'HOST_CANCELLED'
  | 'PLATFORM_CANCELLED'
  | 'LATE_PAYMENT_UNAVAILABLE'
  | 'DUPLICATE_PAYMENT'
  | 'SERIES_ENDED'
  | 'DISPUTE';

export type PaymentSignal = 'CLIENT_RETURNED' | 'CAPTURED' | 'FAILED' | 'EXPIRED';

/**
 * Allowed moves. A provider order can carry several attempts: a failed attempt may be followed by a successful one,
 * and a success may arrive after we gave up waiting (late success, BR-15). SUCCEEDED is final.
 */
const TABLE: Record<PaymentSignal, Partial<Record<PaymentStatus, PaymentStatus>>> = {
  CLIENT_RETURNED: { CREATED: 'PENDING' },
  CAPTURED: { CREATED: 'SUCCEEDED', PENDING: 'SUCCEEDED', FAILED: 'SUCCEEDED', EXPIRED: 'SUCCEEDED' },
  FAILED: { CREATED: 'FAILED', PENDING: 'FAILED' },
  EXPIRED: { CREATED: 'EXPIRED', PENDING: 'EXPIRED' },
};

export function nextPaymentStatus(from: PaymentStatus, signal: PaymentSignal): PaymentStatus | null {
  return TABLE[signal][from] ?? null;
}

/** An unpaid order is given up after this long (Razorpay orders stay payable; a late capture is still honoured). */
export const PAYMENT_EXPIRY_MINUTES = 30;
