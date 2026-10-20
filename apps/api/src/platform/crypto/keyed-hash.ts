import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Keyed HMAC-SHA256 for blind indexes (lookup of encrypted values such as phone numbers) and for hashing
 * short secrets (OTP codes) so a database leak alone cannot brute-force them (D-037, database-design §11).
 * Each use gets a distinct `purpose` so equal inputs hash differently across uses.
 */
export interface KeyedHasher {
  hash(purpose: string, value: string): Buffer;
  verify(purpose: string, value: string, expected: Buffer): boolean;
}

export function createKeyedHasher(key: Buffer): KeyedHasher {
  if (key.length < 32) throw new Error('blind index key must be at least 32 bytes');
  const hash = (purpose: string, value: string) =>
    createHmac('sha256', key).update(purpose).update('\u0000').update(value).digest();
  return {
    hash,
    verify(purpose, value, expected) {
      const actual = hash(purpose, value);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
