import { describe, expect, it } from 'vitest';
import {
  DEV_ONLY_BLIND_INDEX_KEY,
  DEV_ONLY_FIELD_ENCRYPTION_KEYS,
  EnvValidationError,
  describeEnv,
  loadEnv,
} from '../../src/platform/config/env.ts';

const realKeys = {
  FIELD_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
  BLIND_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const base = {
  DATABASE_URL: 'postgres://app:s3cret-pw@db.internal:5432/parkbro',
  FIELD_ENCRYPTION_KEYS: DEV_ONLY_FIELD_ENCRYPTION_KEYS,
  BLIND_INDEX_KEY: DEV_ONLY_BLIND_INDEX_KEY,
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4101,
      DATABASE_POOL_MAX: 10,
      TRUST_PROXY: false,
    });
    expect(env.API_DOCS_ENABLED).toBe(true);
  });

  it('coerces numbers and booleans from strings', () => {
    const env = loadEnv({ ...base, PORT: '8080', TRUST_PROXY: 'true', API_DOCS_ENABLED: 'false' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.API_DOCS_ENABLED).toBe(false);
  });

  it('rejects a missing DATABASE_URL, naming the key', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid values without echoing them (secrets stay out of error output)', () => {
    let caught: unknown;
    try {
      loadEnv({ ...base, DATABASE_URL: 'mysql://root:topsecretvalue@x/y', PORT: 'not-a-port' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const message = (caught as Error).message;
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain('topsecretvalue');
    expect(message).not.toContain('not-a-port');
  });

  it('requires TLS to the database in production', () => {
    expect(() => loadEnv({ ...base, ...realKeys, NODE_ENV: 'production' })).toThrow(/must use TLS/);
  });

  it('staging (D-172): simulators allowed only with an allowlist; never dev keys; TLS may be off only there', () => {
    const staging = {
      ...base,
      ...realKeys,
      NODE_ENV: 'production',
      STAGING: 'true',
      OTP_PROVIDER: 'dev-fixed',
      OTP_DEV_FIXED_CODE: '246810',
      DATABASE_SSL: 'disable',
    };
    expect(() => loadEnv(staging)).toThrow(/STAGING_ALLOWED_PHONES/);
    const env = loadEnv({ ...staging, STAGING_ALLOWED_PHONES: '9000000001, +919000000009' });
    expect(env).toMatchObject({ STAGING: true, PAYMENT_PROVIDER: 'fake', DATABASE_SSL: 'disable' });
    expect(() => loadEnv({ ...staging, STAGING_ALLOWED_PHONES: '12345' })).toThrow(/STAGING_ALLOWED_PHONES/);
    expect(() =>
      loadEnv({
        ...staging,
        ...{ FIELD_ENCRYPTION_KEYS: base.FIELD_ENCRYPTION_KEYS },
        STAGING_ALLOWED_PHONES: '9000000001',
      }),
    ).toThrow(/development key/);
    // Without STAGING the same settings are refused.
    let message = '';
    try {
      loadEnv({ ...staging, STAGING: 'false', STAGING_ALLOWED_PHONES: '9000000001' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/OTP_PROVIDER/);
    expect(message).toMatch(/PAYMENT_PROVIDER/);
    expect(message).toMatch(/must use TLS/);
    // DATABASE_SSL=no-verify satisfies the production TLS rule without a URL parameter.
    expect(() =>
      loadEnv({ ...base, ...realKeys, NODE_ENV: 'production', DATABASE_SSL: 'no-verify' }),
    ).not.toThrow(/must use TLS/);
  });

  it('refuses the public development keys outside development and test', () => {
    let message = '';
    try {
      loadEnv({ ...base, NODE_ENV: 'production', DATABASE_URL: `${base.DATABASE_URL}?sslmode=require` });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/FIELD_ENCRYPTION_KEYS: development key/);
    expect(message).toMatch(/BLIND_INDEX_KEY: development key/);
  });

  it('cannot start in production until a real OTP provider exists (Phase 18)', () => {
    expect(() =>
      loadEnv({
        ...base,
        ...realKeys,
        NODE_ENV: 'production',
        DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`,
      }),
    ).toThrow(/OTP_PROVIDER: no production OTP provider/);
  });

  it('validates key formats and the dev-fixed OTP code', () => {
    expect(() => loadEnv({ ...base, FIELD_ENCRYPTION_KEYS: 'v1:dG9vLXNob3J0' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...base, OTP_PROVIDER: 'dev-fixed' })).toThrow(/OTP_DEV_FIXED_CODE/);
    expect(
      loadEnv({ ...base, OTP_PROVIDER: 'dev-fixed', OTP_DEV_FIXED_CODE: '246810' }).OTP_DEV_FIXED_CODE,
    ).toBe('246810');
  });

  it('payments: Razorpay needs its keys; production refuses the fake provider and test keys', () => {
    expect(loadEnv(base).PAYMENT_PROVIDER).toBe('fake');
    expect(() => loadEnv({ ...base, PAYMENT_PROVIDER: 'razorpay' })).toThrow(/RAZORPAY_KEY_ID: required/);
    const rzp = {
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_abc123',
      RAZORPAY_KEY_SECRET: 'k'.repeat(24),
      RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(24),
    };
    expect(loadEnv({ ...base, ...rzp }).RAZORPAY_KEY_ID).toBe('rzp_test_abc123');
    const prod = {
      ...base,
      ...realKeys,
      NODE_ENV: 'production',
      DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`,
    };
    expect(() => loadEnv(prod)).toThrow(/PAYMENT_PROVIDER: the fake payment provider is not allowed/);
    expect(() => loadEnv({ ...prod, ...rzp })).toThrow(/RAZORPAY_KEY_ID: test keys are not allowed/);
    const described = JSON.stringify(describeEnv(loadEnv({ ...base, ...rzp })));
    expect(described).not.toContain('kkkk');
    expect(described).not.toContain('wwww');
  });

  it('describeEnv never includes credentials', () => {
    const described = JSON.stringify(describeEnv(loadEnv(base)));
    expect(described).not.toContain('s3cret-pw');
    expect(described).not.toContain('app:');
    expect(described).toContain('db.internal');
  });
});
