/** Events the payments module publishes inside its own transactions (the ledger posts from them, Phase 16). */
declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    'payment.captured': { paymentId: string; bookingId: string; amountPaise: number; requestId: string };
    'payment.failed': { paymentId: string; bookingId: string; requestId: string };
    'payment.refund_succeeded': { refundId: string; bookingId: string; amountPaise: number };
    'payment.refund_recorded': {
      refundId: string;
      paymentId: string;
      bookingId: string;
      amountPaise: number;
      requestId: string;
    };
  }
}

export {};
