/**
 * Payment provider seam (architecture §5 "PaymentProvider", D-120). The application only ever believes what the
 * provider says through a signature-verified webhook or a server-side API query, never the browser (CLAUDE.md §15).
 * Amounts are integer paise.
 */
export type ProviderName = 'FAKE' | 'RAZORPAY';

/** A provider's view of one payment attempt, normalised. */
export interface ProviderPayment {
  paymentId: string;
  orderId: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  amountPaise: number;
  currency: string;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

export interface ProviderRefund {
  refundId: string;
  paymentId: string;
  amountPaise: number;
  status: 'pending' | 'processed' | 'failed';
}

export type ProviderEvent =
  | { eventId: string; type: 'payment'; payment: ProviderPayment }
  | { eventId: string; type: 'refund'; refund: ProviderRefund }
  | { eventId: string; type: 'ignored'; name: string };

export interface SettlementLine {
  settlementId: string;
  entityKind: 'PAYMENT' | 'REFUND' | 'ADJUSTMENT';
  entityId: string;
  amountPaise: number;
  feePaise: number;
  taxPaise: number;
  settledAt: Date;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }>;
  /** What the browser needs to open checkout (public values only, never secrets). */
  checkoutParams(order: { orderId: string; amountPaise: number }): Record<string, string | number>;
  /** Signature over the exact raw request body. Constant-time. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderEvent;
  /** The checkout handler's signature (order|payment). Only a hint to fetch; never sufficient for success. */
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  capture(paymentId: string, amountPaise: number): Promise<ProviderPayment>;
  /** Idempotent per `receipt` (our refund id). */
  refund(input: { paymentId: string; amountPaise: number; receipt: string }): Promise<ProviderRefund>;
  fetchRefund(paymentId: string, refundId: string): Promise<ProviderRefund>;
  /** Settlement report lines for one UTC day (YYYY-MM-DD). */
  fetchSettlements(day: string): Promise<SettlementLine[]>;
}

export const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
