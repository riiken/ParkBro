import { describe, expect, it } from 'vitest';
import { manualIntegration } from '../../src/modules/charging/domain/integration.ts';
import {
  canStartAt,
  maxEnergyKwh,
  nextSessionStatus,
  speedClass,
} from '../../src/modules/charging/domain/session.ts';

describe('charging session domain (§5.9)', () => {
  it('allows only the defined transitions', () => {
    expect(nextSessionStatus('NOT_STARTED', 'START')).toBe('CHARGING');
    expect(nextSessionStatus('CHARGING', 'STOP')).toBe('STOPPED_EARLY');
    expect(nextSessionStatus('CHARGING', 'COMPLETE')).toBe('COMPLETED');
    expect(nextSessionStatus('NOT_STARTED', 'FAULT')).toBe('FAULTED');
    expect(nextSessionStatus('CHARGING', 'FAULT')).toBe('FAULTED');
    expect(nextSessionStatus('NOT_STARTED', 'STOP')).toBeNull();
    expect(nextSessionStatus('NOT_STARTED', 'COMPLETE')).toBeNull();
    for (const terminal of ['COMPLETED', 'STOPPED_EARLY', 'FAULTED'] as const) {
      for (const a of ['START', 'STOP', 'COMPLETE', 'FAULT'] as const)
        expect(nextSessionStatus(terminal, a)).toBeNull();
    }
  });

  it('start window: 15 minutes early until the end (half-open)', () => {
    const w = { start: 1_000_000_000, end: 1_000_000_000 + 3_600_000 };
    expect(canStartAt(w, w.start - 15 * 60_000)).toBe(true);
    expect(canStartAt(w, w.start - 15 * 60_000 - 1)).toBe(false);
    expect(canStartAt(w, w.end - 1)).toBe(true);
    expect(canStartAt(w, w.end)).toBe(false);
  });

  it('speed classes and the energy planning bound', () => {
    expect(speedClass('AC', 3.3)).toBe('SLOW');
    expect(speedClass('AC', 7)).toBe('FAST');
    expect(speedClass('AC', 22)).toBe('FAST');
    expect(speedClass('DC', 25)).toBe('RAPID');
    expect(maxEnergyKwh(7.4, 120)).toBe(14.5);
    expect(maxEnergyKwh(3.3, 60)).toBe(3);
    expect(maxEnergyKwh(50, 30)).toBe(25);
  });

  it('the manual integration accepts, reports no energy and never claims a status', async () => {
    const ref = { assetId: 'a', integrationRef: null };
    expect(await manualIntegration.startSession(ref, { sessionId: 's', bookingId: 'b' })).toEqual({
      accepted: true,
      externalRef: null,
    });
    expect(await manualIntegration.readEnergy(ref, { sessionId: 's', externalRef: null })).toBeNull();
    expect(await manualIntegration.getStatus(ref)).toBe('UNKNOWN');
    expect(manualIntegration.metering).toBe('NONE');
  });
});
