import { describe, expect, it } from 'vitest';
import {
  destination,
  fuzzPoint,
  haversineMeters,
  isInIndia,
} from '../../src/modules/properties/domain/geo.ts';
import {
  PARTICIPATION_STATUSES,
  canTransitionParticipation,
} from '../../src/modules/properties/domain/participation.ts';
import { isValidTimezone } from '../../src/modules/properties/application/property-service.ts';
import { findContactDetails } from '../../src/platform/text/contact-details.ts';
import { localDiskStorage } from '../../src/platform/providers/object-storage.ts';

const koramangala = { latitude: 12.9352, longitude: 77.6245 };

describe('public point fuzzing (trust-and-safety L-1)', () => {
  it('residential offsets fall within 200–500 m, commercial within 0–100 m', () => {
    for (let i = 0; i < 500; i++) {
      const house = haversineMeters(koramangala, fuzzPoint(koramangala, 'INDEPENDENT_HOUSE'));
      const society = haversineMeters(koramangala, fuzzPoint(koramangala, 'APARTMENT_SOCIETY'));
      const shop = haversineMeters(koramangala, fuzzPoint(koramangala, 'COMMERCIAL'));
      expect(house).toBeGreaterThanOrEqual(199);
      expect(house).toBeLessThanOrEqual(501);
      expect(society).toBeGreaterThanOrEqual(199);
      expect(shop).toBeLessThanOrEqual(101);
    }
  });

  it('unknown property kinds get the residential (stronger) protection', () => {
    expect(
      haversineMeters(
        koramangala,
        fuzzPoint(koramangala, 'OTHER', () => 0),
      ),
    ).toBeCloseTo(200, 0);
  });

  it('is deterministic for a given random source (stored once, never recomputed per request)', () => {
    const seq = [0.3, 0.7];
    const a = fuzzPoint(koramangala, 'INDEPENDENT_HOUSE', () => seq.shift() ?? 0);
    const seq2 = [0.3, 0.7];
    const b = fuzzPoint(koramangala, 'INDEPENDENT_HOUSE', () => seq2.shift() ?? 0);
    expect(a).toEqual(b);
  });

  it('destination and haversine agree', () => {
    expect(haversineMeters(koramangala, destination(koramangala, 1234, 1.1))).toBeCloseTo(1234, 0);
  });

  it('service area is India only', () => {
    expect(isInIndia(koramangala)).toBe(true);
    expect(isInIndia({ latitude: 51.5, longitude: -0.12 })).toBe(false);
  });
});

describe('society participation transitions (domain-model §5.2)', () => {
  const allowed = new Set([
    'CONSENT_REQUIRED>PENDING_CONSENT',
    'PENDING_CONSENT>PARTICIPATING',
    'PENDING_CONSENT>CONSENT_REQUIRED',
    'PARTICIPATING>SUSPENDED',
    'PARTICIPATING>WITHDRAWN',
    'SUSPENDED>PARTICIPATING',
    'SUSPENDED>WITHDRAWN',
    'WITHDRAWN>PENDING_CONSENT',
  ]);
  for (const from of PARTICIPATION_STATUSES) {
    for (const to of PARTICIPATION_STATUSES) {
      it(`${from} → ${to}: ${allowed.has(`${from}>${to}`) ? 'allowed' : 'rejected'}`, () => {
        expect(canTransitionParticipation(from, to)).toBe(allowed.has(`${from}>${to}`));
      });
    }
  }
});

describe('contact details in public text', () => {
  it.each([
    'Call 98765 43210',
    'call +91-98765-43210',
    'ph 9876543210',
    'mail me at a.b@gmail.com',
    'pay to ravi@okaxis',
    'see www.example.com',
    'example.in for details',
    'WhatsApp me',
    'https://wa.me/123',
  ])('blocks: %s', (text) => expect(findContactDetails(text)).not.toBeNull());

  it.each([
    'Covered basement slot B2-14',
    'Height limit 2.1 m, fits SUVs',
    'Gate opens 7:00-22:00',
    'Near Forum Mall, 4th Block',
  ])('allows: %s', (text) => expect(findContactDetails(text)).toBeNull());
});

describe('local disk storage key safety', () => {
  const storage = localDiskStorage('/tmp/unused-root');
  it.each(['../etc/passwd.txt', 'a/../../b.webp', '/abs/path.webp', 'UPPER.webp', 'noext'])(
    'rejects %s',
    async (key) => {
      await expect(storage.put(key, Buffer.from('x'), 'image/webp')).rejects.toThrow();
    },
  );
});

describe('timezone validation', () => {
  it('accepts IANA names including Asia/Kolkata (which ICU lists only as Asia/Calcutta)', () => {
    for (const tz of [
      'Asia/Kolkata',
      'Asia/Calcutta',
      'UTC',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
    ]) {
      expect(isValidTimezone(tz)).toBe(true);
    }
  });
  it('rejects unknown or malformed zones', () => {
    for (const tz of ['Mars/Olympus', 'Kolkata', '', '../../etc', 'Asia/Kolkata; DROP'])
      expect(isValidTimezone(tz)).toBe(false);
  });
});
