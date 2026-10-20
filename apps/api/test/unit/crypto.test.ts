import { describe, expect, it } from 'vitest';
import { FieldCipherError, createFieldCipher, parseKeyring } from '../../src/platform/crypto/field-cipher.ts';
import { createKeyedHasher } from '../../src/platform/crypto/keyed-hash.ts';
import { UUID_PATTERN, uuidv7 } from '../../src/platform/ids/uuid.ts';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

describe('field cipher (AES-256-GCM)', () => {
  const cipher = createFieldCipher(new Map([[1, k1]]));

  it('round-trips and never produces the same ciphertext twice', () => {
    const a = cipher.encrypt('+919876543210', 'identity.phone');
    const b = cipher.encrypt('+919876543210', 'identity.phone');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('9876543210'))).toBe(false);
    expect(cipher.decrypt(a, 'identity.phone')).toBe('+919876543210');
  });

  it('detects tampering and refuses a ciphertext moved to another column (context binding)', () => {
    const c = cipher.encrypt('secret', 'identity.phone');
    const tampered = Buffer.from(c);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, 'identity.phone')).toThrow(FieldCipherError);
    expect(() => cipher.decrypt(c, 'identity.admin_mfa.totp')).toThrow(FieldCipherError);
  });

  it('rotates keys: new data uses the newest key, old data still decrypts', () => {
    const old = cipher.encrypt('legacy', 'ctx');
    const rotated = createFieldCipher(
      new Map([
        [1, k1],
        [2, k2],
      ]),
    );
    expect(rotated.decrypt(old, 'ctx')).toBe('legacy');
    expect(rotated.encrypt('new', 'ctx')[0]).toBe(2);
    expect(() => createFieldCipher(new Map([[2, k2]])).decrypt(old, 'ctx')).toThrow(/unknown key version 1/);
  });

  it('parses keyrings and rejects bad keys', () => {
    expect([...parseKeyring(`v1:${k1.toString('base64')},v3:${k2.toString('base64')}`).keys()]).toEqual([
      1, 3,
    ]);
    expect(() => parseKeyring('nope')).toThrow(FieldCipherError);
    expect(() => createFieldCipher(new Map([[1, Buffer.alloc(16)]]))).toThrow(/32 bytes/);
  });
});

describe('keyed hasher (blind index)', () => {
  const hasher = createKeyedHasher(k1);
  it('is deterministic per purpose and differs across purposes and keys', () => {
    expect(hasher.hash('phone', 'x').equals(hasher.hash('phone', 'x'))).toBe(true);
    expect(hasher.hash('phone', 'x').equals(hasher.hash('otp', 'x'))).toBe(false);
    expect(createKeyedHasher(k2).hash('phone', 'x').equals(hasher.hash('phone', 'x'))).toBe(false);
    expect(hasher.verify('phone', 'x', hasher.hash('phone', 'x'))).toBe(true);
    expect(hasher.verify('phone', 'y', hasher.hash('phone', 'x'))).toBe(false);
  });
});

describe('uuidv7', () => {
  it('is a valid, time-ordered UUID v7', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(UUID_PATTERN);
    expect(a[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(a < b).toBe(true);
  });
});
