import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from '../../src/platform/auth/session-token.ts';

describe('session tokens', () => {
  it('are 256-bit base64url strings and unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(isWellFormedSessionToken(token)).toBe(true);
    expect(Buffer.from([...tokens][0] ?? '', 'base64url')).toHaveLength(32);
  });

  it('hash deterministically to 32 bytes and differ per token', () => {
    const a = generateSessionToken();
    expect(hashSessionToken(a)).toHaveLength(32);
    expect(hashSessionToken(a).equals(hashSessionToken(a))).toBe(true);
    expect(hashSessionToken(a).equals(hashSessionToken(generateSessionToken()))).toBe(false);
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`]) {
      expect(isWellFormedSessionToken(bad)).toBe(false);
    }
  });
});
