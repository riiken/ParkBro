import { describe, expect, it } from 'vitest';
import { parseSearchText } from '../../src/modules/ai/domain/rules-parser.ts';
import {
  describe as chipsOf,
  emptyIntent,
  normalise,
  redact,
  searchIntentSchema,
} from '../../src/modules/ai/domain/search-intent.ts';
import { EVAL_NOW, SEARCH_CASES } from '../../src/modules/ai/eval/search-cases.ts';

describe('rules parser (fallback) on the evaluation set', () => {
  for (const c of SEARCH_CASES) {
    it(c.text, () => {
      const intent = parseSearchText(redact(c.text), EVAL_NOW);
      expect(searchIntentSchema.safeParse(intent).success).toBe(true); // same contract as the model
      const { place, ...rest } = c.expect;
      expect(intent).toMatchObject(rest);
      if (place !== undefined) expect(intent.place?.toLowerCase() ?? null).toBe(place?.toLowerCase() ?? null);
    });
  }

  it('leaves what it does not understand empty instead of guessing', () => {
    expect(parseSearchText('somewhere nice please', EVAL_NOW)).toEqual(emptyIntent());
  });
});

describe('intent contract', () => {
  it('rejects outputs that try to carry anything but filters', () => {
    const ok = { ...emptyIntent(), place: 'Koramangala' };
    expect(searchIntentSchema.safeParse(ok).success).toBe(true);
    for (const extra of [{ action: 'BOOK' }, { bookingId: 'x' }, { latitude: 12.9 }, { available: true }]) {
      expect(searchIntentSchema.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(searchIntentSchema.safeParse({ ...ok, maxPriceRupees: -5 }).success).toBe(false);
    expect(searchIntentSchema.safeParse({ ...ok, from: '25:00' }).success).toBe(false);
    expect(searchIntentSchema.safeParse({ ...ok, connector: 'TESLA' }).success).toBe(false);
  });

  it('redacts contact details and plates before text leaves the platform', () => {
    expect(redact('call me on +91 98450 12345 or a@b.com, my car KA 01 AB 1234, near HSR')).toBe(
      'call me on [number] or [email], my car [plate], near HSR',
    );
    expect(redact('parking on 12 2026')).toBe('parking on 12 2026');
    expect(redact('x'.repeat(400))).toHaveLength(300);
  });
});

describe('normalise', () => {
  it('drops filters for the other asset type and keeps dates bookable', () => {
    const { filters, notes } = normalise(
      {
        ...emptyIntent('EV_CHARGING'),
        covered: true,
        security: ['CCTV'],
        vehicleClass: 'SUV',
        connector: 'CCS2',
        mode: 'MONTHLY',
        date: '2027-06-01',
      },
      EVAL_NOW,
    );
    expect(filters).toMatchObject({
      type: 'EV_CHARGING',
      covered: false,
      security: [],
      vehicleClass: null,
      connector: 'CCS2',
      mode: null,
      date: null,
    });
    expect(notes).toHaveLength(2);
  });

  it('a time without a date is today, or tomorrow once it has passed; no invented end times', () => {
    expect(normalise({ ...emptyIntent(), from: '18:00' }, EVAL_NOW).filters).toMatchObject({
      date: '2026-10-20',
      from: '18:00',
      to: null,
    });
    expect(normalise({ ...emptyIntent(), from: '08:00' }, EVAL_NOW).filters.date).toBe('2026-10-21');
  });

  it('a price needs a priced mode: hourly for parking, per session for charging', () => {
    expect(normalise({ ...emptyIntent(), maxPriceRupees: 50 }, EVAL_NOW).filters).toMatchObject({
      mode: 'HOURLY',
      maxPricePaise: 5000,
    });
    expect(normalise({ ...emptyIntent('EV_CHARGING'), maxPriceRupees: 200 }, EVAL_NOW).filters.mode).toBe(
      'CHARGING_SESSION',
    );
  });

  it('describes only validated fields', () => {
    const { filters } = normalise(
      {
        ...emptyIntent(),
        mode: 'HOURLY',
        date: '2026-10-21',
        from: '09:00',
        to: '18:00',
        maxPriceRupees: 60,
        covered: true,
      },
      EVAL_NOW,
    );
    expect(
      chipsOf({ ...filters, place: { name: 'Indiranagar', latitude: 12.97, longitude: 77.64 } }),
    ).toEqual([
      'Parking',
      'Near Indiranagar',
      'Hourly',
      'Wed 21 Oct, 09:00–18:00',
      'Up to ₹60/hour',
      'Covered',
    ]);
  });
});

describe('evaluation harness', () => {
  it('scores a model by field and counts invalid outputs and errors', async () => {
    const { evaluateSearch, scriptedLlm, LlmError } = await import('../../src/modules/ai/index.ts');
    let n = 0;
    const flaky = scriptedLlm(() => {
      n += 1;
      if (n === 1) throw new LlmError('TIMEOUT', 'timeout');
      if (n === 2) return { nonsense: true };
      return emptyIntent();
    });
    const cases = SEARCH_CASES.slice(0, 3);
    const report = await evaluateSearch(flaky, cases, EVAL_NOW);
    expect(report).toMatchObject({
      answeredBy: 'scripted:scripted-1',
      cases: 3,
      errors: 1,
      invalidOutputs: 1,
    });
    expect(report.correctFields).toBe(1); // only "assetType: PARKING" of the third case
    expect(report.accuracy).toBeLessThan(0.9);
    expect(flaky.calls[0]?.tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
