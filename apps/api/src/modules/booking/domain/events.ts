/** Events the booking module publishes (in the publisher's transaction, D-065). */
export type RefundCause = 'CUSTOMER_CANCELLED' | 'HOST_CANCELLED' | 'PLATFORM_CANCELLED' | 'SERIES_ENDED';

declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    /** A cancellation fixed a refund amount for a paid booking; payments records and executes it (Phase 15). */
    'booking.refund_due': { bookingId: string; amountPaise: number; cause: RefundCause; requestId: string };
    /** A booking became CONFIRMED (paid): access is issued (Phase 17). */
    'booking.confirmed': {
      bookingId: string;
      propertyId: string;
      assetId: string;
      unitId: string;
      customerId: string;
      vehicleId: string;
      start: number;
      end: number;
      requestId: string;
    };
    /** A request now waits for the host (notifications). */
    'booking.requested': { bookingId: string; requestId: string };
    /** The host approved a request: the customer can pay. */
    'booking.approved': { bookingId: string; requestId: string };
    /** "I can't get in": the host must act within the deadline (BR-24). */
    'booking.issue_opened': {
      bookingId: string;
      issueId: string;
      kind: string;
      deadlineAt: Date;
      requestId: string;
    };
    /** A booking reached a final state: access is revoked or ends. */
    'booking.closed': {
      bookingId: string;
      status: 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'DECLINED' | 'NO_SHOW';
      requestId: string;
    };
  }
}

export {};
