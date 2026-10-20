import { describe, expect, it } from 'vitest';
import { captureSplit, refundSplit } from '../../src/modules/earnings/domain/split.ts';

const sum = (s: {
  serviceFeePaise: number;
  commissionPaise: number;
  taxPaise: number;
  hostNetPaise: number;
}) => s.serviceFeePaise + s.commissionPaise + s.taxPaise + s.hostNetPaise;

describe('captureSplit', () => {
  it('separates fee, commission, tax and host net, adding up to what the customer paid', () => {
    const s = captureSplit({
      totalPaise: 10_500,
      basePaise: 10_000,
      serviceFeePaise: 500,
      commissionBps: 1000,
    });
    expect(s).toEqual({
      totalPaise: 10_500,
      serviceFeePaise: 500,
      commissionPaise: 1000,
      taxPaise: 0,
      hostNetPaise: 9000,
    });
    expect(sum(s)).toBe(10_500);
  });
  it('tax is carved from platform revenue; the host net does not change', () => {
    const s = captureSplit(
      { totalPaise: 10_500, basePaise: 10_000, serviceFeePaise: 500, commissionBps: 1000 },
      1800,
    );
    expect(s.taxPaise).toBe(270); // 18% of 1500
    expect(s.hostNetPaise).toBe(9000);
    expect(sum(s)).toBe(10_500);
  });
  it('rounds half up and rejects inconsistent facts', () => {
    expect(
      captureSplit({ totalPaise: 4005, basePaise: 4005, serviceFeePaise: 0, commissionBps: 1000 })
        .commissionPaise,
    ).toBe(401);
    expect(() =>
      captureSplit({ totalPaise: 100, basePaise: 90, serviceFeePaise: 5, commissionBps: 1000 }),
    ).toThrow(RangeError);
  });
});

describe('refundSplit', () => {
  const capture = captureSplit(
    { totalPaise: 8003, basePaise: 7603, serviceFeePaise: 400, commissionBps: 1000 },
    1800,
  );
  it('a full refund reverses everything exactly', () => {
    expect(refundSplit(capture, 8003)).toEqual(capture);
  });
  it('a partial refund reverses proportionally and always adds up', () => {
    for (const r of [1, 7, 1000, 4001, 8002]) {
      const s = refundSplit(capture, r);
      expect(sum(s)).toBe(r);
      expect(s.hostNetPaise).toBeGreaterThanOrEqual(0);
      expect(s.commissionPaise).toBeLessThanOrEqual(capture.commissionPaise);
    }
    expect(
      refundSplit(
        captureSplit({ totalPaise: 10_000, basePaise: 10_000, serviceFeePaise: 0, commissionBps: 1000 }),
        5000,
      ),
    ).toMatchObject({
      commissionPaise: 500,
      hostNetPaise: 4500,
    });
  });
  it('rejects refunds out of range', () => {
    expect(() => refundSplit(capture, 0)).toThrow(RangeError);
    expect(() => refundSplit(capture, 8004)).toThrow(RangeError);
  });
});
