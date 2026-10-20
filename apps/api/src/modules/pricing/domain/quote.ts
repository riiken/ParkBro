import { DateTime } from 'luxon';

/**
 * Deterministic pricing (BR-11, BR-13, BR-16, BR-17). Pure: same inputs → same quote. Never computed by a client or
 * an LLM. Amounts are integer paise.
 *
 * PRICING_CONFIG values are pilot placeholders pending the owner's fee decision (D-010, Q-6). They are versioned
 * and snapshotted onto every booking, so changing them never alters existing bookings.
 */
export const PRICING_CONFIG = {
  version: 'pilot-draft-1',
  /** Customer service fee in basis points of the base price (0 until decided). */
  serviceFeeBps: 0,
  /** Host commission in basis points (used for host earnings in Phase 16; snapshotted now). */
  hostCommissionBps: 1000,
} as const;

export type Mode = 'HOURLY' | 'DAILY' | 'OVERNIGHT' | 'MONTHLY' | 'CHARGING_SESSION';
export type Unit = 'PER_HOUR' | 'PER_DAY' | 'PER_NIGHT' | 'PER_MONTH' | 'PER_SESSION';

export interface RateForQuote {
  mode: Mode;
  unit: Unit;
  pricePaise: number;
  overnightStart: string | null;
  overnightEnd: string | null;
}

export interface QuoteLine {
  kind: 'BASE' | 'SERVICE_FEE';
  label: string;
  quantity: number;
  unitPricePaise: number;
  amountPaise: number;
}

export interface Quote {
  mode: Mode;
  lines: QuoteLine[];
  basePaise: number;
  serviceFeePaise: number;
  totalPaise: number;
  configVersion: string;
  hostCommissionBps: number;
}

export type QuoteError =
  'MODE_NOT_OFFERED' | 'INVALID_WINDOW' | 'OVERNIGHT_WINDOW_MISMATCH' | 'MONTHLY_WINDOW_MISMATCH';

const MINUTE = 60_000;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Basis-point fee, rounded half-up to the paisa. */
export function bps(amountPaise: number, basisPoints: number): number {
  return Math.floor((amountPaise * basisPoints + 5000) / 10_000);
}

export function computeQuote(input: {
  rates: readonly RateForQuote[];
  mode: Mode;
  start: number;
  end: number;
  timezone: string;
  config?: { version: string; serviceFeeBps: number; hostCommissionBps: number };
}): { ok: true; quote: Quote } | { ok: false; error: QuoteError } {
  const config = input.config ?? PRICING_CONFIG;
  const rate = input.rates.find((r) => r.mode === input.mode);
  if (!rate) return { ok: false, error: 'MODE_NOT_OFFERED' };
  if (!(input.end > input.start) || input.start % MINUTE !== 0 || input.end % MINUTE !== 0) {
    return { ok: false, error: 'INVALID_WINDOW' };
  }
  const minutes = (input.end - input.start) / MINUTE;
  const startLocal = DateTime.fromMillis(input.start, { zone: input.timezone });
  const endLocal = DateTime.fromMillis(input.end, { zone: input.timezone });

  let quantity: number;
  let label: string;
  switch (input.mode) {
    case 'HOURLY':
    case 'CHARGING_SESSION':
      if (rate.unit === 'PER_SESSION') {
        quantity = 1;
        label = 'Charging session';
      } else {
        // Billed per started hour.
        quantity = Math.ceil(minutes / 60);
        label = plural(quantity, 'hour');
      }
      break;
    case 'DAILY':
      quantity = Math.ceil(minutes / (24 * 60)); // per started 24 h
      label = plural(quantity, 'day');
      break;
    case 'OVERNIGHT': {
      // Exactly the listing's overnight window (start time → end time, next day if it wraps).
      const os = rate.overnightStart ?? '';
      const oe = rate.overnightEnd ?? '';
      const expectedEnd = (oe <= os ? startLocal.plus({ days: 1 }) : startLocal).set({
        hour: Number(oe.slice(0, 2)),
        minute: Number(oe.slice(3, 5)),
        second: 0,
        millisecond: 0,
      });
      if (startLocal.toFormat('HH:mm') !== os || endLocal.toMillis() !== expectedEnd.toMillis()) {
        return { ok: false, error: 'OVERNIGHT_WINDOW_MISMATCH' };
      }
      quantity = 1;
      label = `1 night (${os}–${oe})`;
      break;
    }
    case 'MONTHLY':
      // One calendar month in the property's timezone; short months clamp (31 Jan → 28/29 Feb), BR-13.
      if (startLocal.plus({ months: 1 }).toMillis() !== input.end)
        return { ok: false, error: 'MONTHLY_WINDOW_MISMATCH' };
      quantity = 1;
      label = '1 month';
      break;
  }

  const basePaise = quantity * rate.pricePaise;
  const serviceFeePaise = bps(basePaise, config.serviceFeeBps);
  const lines: QuoteLine[] = [
    { kind: 'BASE', label, quantity, unitPricePaise: rate.pricePaise, amountPaise: basePaise },
  ];
  if (serviceFeePaise > 0) {
    lines.push({
      kind: 'SERVICE_FEE',
      label: 'Service fee',
      quantity: 1,
      unitPricePaise: serviceFeePaise,
      amountPaise: serviceFeePaise,
    });
  }
  return {
    ok: true,
    quote: {
      mode: input.mode,
      lines,
      basePaise,
      serviceFeePaise,
      totalPaise: basePaise + serviceFeePaise,
      configVersion: config.version,
      hostCommissionBps: config.hostCommissionBps,
    },
  };
}
