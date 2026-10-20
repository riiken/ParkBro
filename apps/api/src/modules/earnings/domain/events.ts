/** Events the earnings module publishes (notifications, Phase 18). */
declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    'payout.settled': {
      payoutId: string;
      hostAccountId: string;
      amountPaise: number;
      status: 'PAID' | 'FAILED';
    };
    'payout_account.reviewed': {
      accountId: string;
      hostAccountId: string;
      decision: 'VERIFIED' | 'REJECTED';
    };
  }
}

export {};
