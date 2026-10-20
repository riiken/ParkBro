import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { CANCELLATION_POLICIES, refundFor } from '../../src/modules/booking/domain/cancellation.ts';
import {
  BOOKING_STATUSES,
  nextStatus,
  type BookingAction,
} from '../../src/modules/booking/domain/state-machine.ts';
import { bps, computeQuote, type RateForQuote } from '../../src/modules/pricing/domain/quote.ts';
import { formatPlate, normalizePlate } from '../../src/modules/users/domain/plate.ts';

const IST = 'Asia/Kolkata';
const t = (iso: string) => DateTime.fromISO(iso, { zone: IST }).toMillis();
const rates: RateForQuote[] = [
  { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000, overnightStart: null, overnightEnd: null },
  { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 25000, overnightStart: null, overnightEnd: null },
  { mode: 'OVERNIGHT', unit: 'PER_NIGHT', pricePaise: 15000, overnightStart: '20:00', overnightEnd: '08:00' },
  { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000, overnightStart: null, overnightEnd: null },
];
const quote = (
  mode: 'HOURLY' | 'DAILY' | 'OVERNIGHT' | 'MONTHLY' | 'CHARGING_SESSION',
  start: string,
  end: string,
  r = rates,
) => computeQuote({ rates: r, mode, start: t(start), end: t(end), timezone: IST });

describe('quotes (BR-11, BR-13)', () => {
  it('hourly bills per started hour', () => {
    const q = quote('HOURLY', '2026-11-02T10:00', '2026-11-02T11:30');
    expect(q).toMatchObject({
      ok: true,
      quote: { basePaise: 8000, totalPaise: 8000, lines: [{ label: '2 hours', quantity: 2 }] },
    });
    expect(quote('HOURLY', '2026-11-02T10:00', '2026-11-02T11:00')).toMatchObject({
      quote: { totalPaise: 4000 },
    });
  });

  it('daily bills per started 24 h', () => {
    expect(quote('DAILY', '2026-11-02T10:00', '2026-11-03T12:00')).toMatchObject({
      quote: { totalPaise: 50000, lines: [{ label: '2 days' }] },
    });
  });

  it('overnight must match the listing window exactly', () => {
    expect(quote('OVERNIGHT', '2026-11-02T20:00', '2026-11-03T08:00')).toMatchObject({
      quote: { totalPaise: 15000 },
    });
    expect(quote('OVERNIGHT', '2026-11-02T21:00', '2026-11-03T08:00')).toEqual({
      ok: false,
      error: 'OVERNIGHT_WINDOW_MISMATCH',
    });
    expect(quote('OVERNIGHT', '2026-11-02T20:00', '2026-11-03T09:00')).toEqual({
      ok: false,
      error: 'OVERNIGHT_WINDOW_MISMATCH',
    });
  });

  it('monthly is exactly one calendar month in local time, clamping short months', () => {
    expect(quote('MONTHLY', '2026-11-02T00:00', '2026-12-02T00:00')).toMatchObject({
      quote: { totalPaise: 300000 },
    });
    expect(quote('MONTHLY', '2027-01-31T09:00', '2027-02-28T09:00')).toMatchObject({ ok: true });
    expect(quote('MONTHLY', '2026-11-02T00:00', '2026-12-01T00:00')).toEqual({
      ok: false,
      error: 'MONTHLY_WINDOW_MISMATCH',
    });
  });

  it('charging: per hour or per session', () => {
    const ev: RateForQuote[] = [
      {
        mode: 'CHARGING_SESSION',
        unit: 'PER_SESSION',
        pricePaise: 50000,
        overnightStart: null,
        overnightEnd: null,
      },
    ];
    expect(quote('CHARGING_SESSION', '2026-11-02T10:00', '2026-11-02T13:00', ev)).toMatchObject({
      quote: { totalPaise: 50000, lines: [{ label: 'Charging session' }] },
    });
  });

  it('rejects modes not offered and invalid windows', () => {
    expect(quote('CHARGING_SESSION', '2026-11-02T10:00', '2026-11-02T11:00')).toEqual({
      ok: false,
      error: 'MODE_NOT_OFFERED',
    });
    expect(quote('HOURLY', '2026-11-02T11:00', '2026-11-02T10:00')).toEqual({
      ok: false,
      error: 'INVALID_WINDOW',
    });
    expect(
      computeQuote({
        rates,
        mode: 'HOURLY',
        start: t('2026-11-02T10:00') + 1000,
        end: t('2026-11-02T11:00'),
        timezone: IST,
      }),
    ).toEqual({ ok: false, error: 'INVALID_WINDOW' });
  });

  it('adds a service fee line from versioned config (rounded half-up)', () => {
    const q = computeQuote({
      rates,
      mode: 'HOURLY',
      start: t('2026-11-02T10:00'),
      end: t('2026-11-02T11:00'),
      timezone: IST,
      config: { version: 'test', serviceFeeBps: 750, hostCommissionBps: 1000 },
    });
    expect(q).toMatchObject({
      ok: true,
      quote: { basePaise: 4000, serviceFeePaise: 300, totalPaise: 4300, configVersion: 'test' },
    });
    expect(bps(333, 1500)).toBe(50); // 49.95 → 50
    expect(bps(1, 4999)).toBe(0);
  });
});

describe('booking state machine (§5.3)', () => {
  const allowed = new Set([
    'HOST_APPROVE:AWAITING_HOST_APPROVAL>PENDING_PAYMENT',
    'HOST_DECLINE:AWAITING_HOST_APPROVAL>DECLINED',
    'EXPIRE:AWAITING_HOST_APPROVAL>EXPIRED',
    'EXPIRE:PENDING_PAYMENT>EXPIRED',
    'PAYMENT_SUCCEEDED:PENDING_PAYMENT>CONFIRMED',
    'CHECK_IN:CONFIRMED>IN_PROGRESS',
    'COMPLETE:IN_PROGRESS>COMPLETED',
    'COMPLETE:CONFIRMED>COMPLETED',
    'NO_SHOW:CONFIRMED>NO_SHOW',
    'CANCEL:AWAITING_HOST_APPROVAL>CANCELLED',
    'CANCEL:PENDING_PAYMENT>CANCELLED',
    'CANCEL:CONFIRMED>CANCELLED',
    'CANCEL:IN_PROGRESS>CANCELLED',
  ]);
  const actions: BookingAction[] = [
    'HOST_APPROVE',
    'HOST_DECLINE',
    'EXPIRE',
    'PAYMENT_SUCCEEDED',
    'CHECK_IN',
    'COMPLETE',
    'NO_SHOW',
    'CANCEL',
  ];
  for (const action of actions) {
    for (const from of BOOKING_STATUSES) {
      const to = nextStatus(from, action);
      const key = [...allowed].find((k) => k.startsWith(`${action}:${from}>`));
      it(`${action} from ${from} → ${to ?? 'rejected'}`, () =>
        expect(to ? `${action}:${from}>${to}` : undefined).toBe(key));
    }
  }
});

describe('cancellation refunds (BR-21, BR-22)', () => {
  const start = t('2026-11-10T10:00');
  const hoursBefore = (h: number) => start - h * 3_600_000;
  const m = CANCELLATION_POLICIES.MODERATE;
  it('moderate: full ≥ 24 h before, half until start, nothing after', () => {
    expect(
      refundFor({
        policy: m,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: hoursBefore(25),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(10_000);
    expect(
      refundFor({
        policy: m,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: hoursBefore(24),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(10_000);
    expect(
      refundFor({
        policy: m,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: hoursBefore(2),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(5_000);
    expect(
      refundFor({
        policy: m,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: start + 60_000,
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(0);
  });
  it('flexible and strict tiers', () => {
    expect(
      refundFor({
        policy: CANCELLATION_POLICIES.FLEXIBLE,
        paidPaise: 999,
        startMs: start,
        cancelledAtMs: hoursBefore(0.5),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(499);
    expect(
      refundFor({
        policy: CANCELLATION_POLICIES.STRICT,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: hoursBefore(12),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(0);
    expect(
      refundFor({
        policy: CANCELLATION_POLICIES.STRICT,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: hoursBefore(48),
        by: 'CUSTOMER',
      }).refundPaise,
    ).toBe(5_000);
  });
  it('host and platform cancellations refund in full; unpaid bookings refund nothing', () => {
    expect(
      refundFor({
        policy: CANCELLATION_POLICIES.STRICT,
        paidPaise: 10_000,
        startMs: start,
        cancelledAtMs: start + 1,
        by: 'HOST',
      }).refundPaise,
    ).toBe(10_000);
    expect(
      refundFor({ policy: m, paidPaise: 10_000, startMs: start, cancelledAtMs: start, by: 'PLATFORM' })
        .refundPaise,
    ).toBe(10_000);
    expect(
      refundFor({ policy: m, paidPaise: 0, startMs: start, cancelledAtMs: hoursBefore(100), by: 'HOST' })
        .refundPaise,
    ).toBe(0);
  });
});

describe('number plates', () => {
  it.each([
    ['KA 01 AB 1234', 'KA01AB1234'],
    ['ka-01-ab-1234', 'KA01AB1234'],
    ['DL3CAB1234', 'DL3CAB1234'],
    ['MH12 DE 1433', 'MH12DE1433'],
    ['22 BH 1234 AA', '22BH1234AA'],
    ['TN 09 1234', 'TN091234'],
  ])('%s → %s', (input, expected) => expect(normalizePlate(input)).toBe(expected));
  it.each(['1234', 'KA01AB12345', 'KAAB1234', 'K1A01AB1234', '', 'KA01AB12'])('rejects %s', (input) =>
    expect(normalizePlate(input)).toBeNull(),
  );
  it('formats for display', () => {
    expect(formatPlate('KA01AB1234')).toBe('KA 01 AB 1234');
    expect(formatPlate('22BH1234AA')).toBe('22 BH 1234 AA');
  });
});
