/**
 * Cancellation policies (BR-21, BR-22). Versioned templates snapshotted onto each booking; refunds are computed
 * from the snapshot, never from current settings. Pure.
 */
export interface RefundTier {
  /** Applies when cancelling at least this many minutes before the start. */
  minMinutesBeforeStart: number;
  refundBps: number;
}

export interface PolicySnapshot {
  code: 'FLEXIBLE' | 'MODERATE' | 'STRICT';
  version: string;
  tiers: RefundTier[]; // ordered from most to least generous
}

const DAY = 24 * 60;

export const CANCELLATION_POLICIES: Record<PolicySnapshot['code'], PolicySnapshot> = {
  FLEXIBLE: {
    code: 'FLEXIBLE',
    version: 'cancellation-v1',
    tiers: [
      { minMinutesBeforeStart: 60, refundBps: 10_000 },
      { minMinutesBeforeStart: 0, refundBps: 5_000 },
    ],
  },
  MODERATE: {
    code: 'MODERATE',
    version: 'cancellation-v1',
    tiers: [
      { minMinutesBeforeStart: DAY, refundBps: 10_000 },
      { minMinutesBeforeStart: 0, refundBps: 5_000 },
    ],
  },
  STRICT: {
    code: 'STRICT',
    version: 'cancellation-v1',
    tiers: [
      { minMinutesBeforeStart: 7 * DAY, refundBps: 10_000 },
      { minMinutesBeforeStart: DAY, refundBps: 5_000 },
    ],
  },
};

export type Canceller = 'CUSTOMER' | 'HOST' | 'PLATFORM';

/**
 * Refund owed on cancellation. Unpaid bookings refund nothing (nothing was collected). Host and platform
 * cancellations always refund in full (BR-21). After the start, a customer gets nothing back.
 */
export function refundFor(input: {
  policy: PolicySnapshot;
  paidPaise: number;
  startMs: number;
  cancelledAtMs: number;
  by: Canceller;
}): { refundPaise: number; refundBps: number } {
  if (input.paidPaise <= 0) return { refundPaise: 0, refundBps: 0 };
  if (input.by !== 'CUSTOMER') return { refundPaise: input.paidPaise, refundBps: 10_000 };
  const minutesBefore = (input.startMs - input.cancelledAtMs) / 60_000;
  const tier = input.policy.tiers.find((t) => minutesBefore >= t.minMinutesBeforeStart);
  const refundBps = tier?.refundBps ?? 0;
  return { refundPaise: Math.floor((input.paidPaise * refundBps) / 10_000), refundBps };
}
