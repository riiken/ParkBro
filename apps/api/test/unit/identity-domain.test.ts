import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeIndianMobile } from '../../src/modules/identity/domain/phone.ts';
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from '../../src/modules/identity/domain/totp.ts';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['0091-98765-43210', '+919876543210'],
    ['(+91) 6000000000', '+916000000000'],
  ])('%s → %s', (input, expected) => expect(normalizeIndianMobile(input)).toBe(expected));

  it.each(['5876543210', '987654321', '98765432101', '+1 9876543210', 'abcdefghij', '', '+91 98765 4321x'])(
    'rejects %s',
    (input) => expect(normalizeIndianMobile(input)).toBeNull(),
  );

  it('masks to the last four digits', () => expect(maskPhone('3210')).toBe('+91 ••••••3210'));
});

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890"; 6-digit codes are the last 6 of the 8-digit vectors.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('at T=%i the code is %s', (time, code) => {
    expect(hotp(base32Decode(rfcSecret), totpStep(time))).toBe(code);
  });

  it('base32 round-trips', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 17]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('accepts ±1 step and rejects replay of an already-used step', () => {
    const t = 1_700_000_000;
    const step = totpStep(t);
    const previous = hotp(base32Decode(rfcSecret), step - 1);
    expect(verifyTotp({ secretBase32: rfcSecret, code: previous, unixSeconds: t, lastUsedStep: 0 })).toBe(
      step - 1,
    );
    expect(
      verifyTotp({ secretBase32: rfcSecret, code: previous, unixSeconds: t, lastUsedStep: step - 1 }),
    ).toBeNull();
    const twoAgo = hotp(base32Decode(rfcSecret), step - 2);
    expect(verifyTotp({ secretBase32: rfcSecret, code: twoAgo, unixSeconds: t, lastUsedStep: 0 })).toBeNull();
    expect(
      verifyTotp({ secretBase32: rfcSecret, code: 'abcdef', unixSeconds: t, lastUsedStep: 0 }),
    ).toBeNull();
  });

  it('builds an otpauth URI', () => {
    expect(otpauthUri('ABC', 'admin-1234', 'ParkBro Admin')).toBe(
      'otpauth://totp/ParkBro%20Admin%3Aadmin-1234?secret=ABC&issuer=ParkBro%20Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
