/**
 * How one customer payment divides (business-model §2, D-128). Pure, integer paise. Customer payment = booking value
 * (base) + customer service fee. The platform keeps the service fee and its commission on the base; taxes on platform
 * revenue are carved out of that revenue at `taxBps` (0 until the CA review, R-70); the host earns the rest.
 */
export interface PriceFacts {
  totalPaise: number;
  basePaise: number;
  serviceFeePaise: number;
  commissionBps: number;
}

export interface Split {
  totalPaise: number;
  serviceFeePaise: number;
  commissionPaise: number;
  taxPaise: number;
  hostNetPaise: number;
}

/** Basis points, half up (same rounding as pricing). */
export const bps = (amount: number, basisPoints: number) =>
  Math.floor((amount * basisPoints + 5000) / 10_000);

export function captureSplit(p: PriceFacts, taxBps = 0): Split {
  if (p.basePaise + p.serviceFeePaise !== p.totalPaise) throw new RangeError('price facts do not add up');
  const commissionGross = bps(p.basePaise, p.commissionBps);
  const tax = bps(commissionGross + p.serviceFeePaise, taxBps);
  // Tax comes out of platform revenue (commission first, then fee): the host's net never changes with tax.
  const commission = Math.max(0, commissionGross - tax);
  const fee = p.serviceFeePaise - Math.max(0, tax - commissionGross);
  return {
    totalPaise: p.totalPaise,
    serviceFeePaise: fee,
    commissionPaise: commission,
    taxPaise: tax,
    hostNetPaise: p.basePaise - commissionGross,
  };
}

/**
 * A refund of `refundPaise` reverses each part in proportion (a 50% refund returns 50% of the fee, the commission,
 * the tax and the host's share). The host side absorbs rounding so the parts always add up exactly.
 */
export function refundSplit(capture: Split, refundPaise: number): Split {
  if (refundPaise <= 0 || refundPaise > capture.totalPaise) throw new RangeError('refund out of range');
  const part = (x: number) => Math.floor((x * refundPaise) / capture.totalPaise);
  const serviceFeePaise = part(capture.serviceFeePaise);
  const commissionPaise = part(capture.commissionPaise);
  const taxPaise = part(capture.taxPaise);
  return {
    totalPaise: refundPaise,
    serviceFeePaise,
    commissionPaise,
    taxPaise,
    hostNetPaise: refundPaise - serviceFeePaise - commissionPaise - taxPaise,
  };
}

/** BR-18: earnings become available this long after the booking ends (the dispute window until disputes exist). */
export const RELEASE_AFTER_END_HOURS = 48;
/** Smallest payout (bank and UPI costs). */
export const MIN_PAYOUT_PAISE = 10_000;
/** A changed payout account waits this long before money is sent to it (R-17). */
export const PAYOUT_ACCOUNT_CHANGE_HOLD_HOURS = 72;
