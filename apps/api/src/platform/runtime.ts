import type { Kysely } from 'kysely';
import { createAuditLog, type AuditTables } from './audit/audit-log.ts';
import type { Env } from './config/env.ts';
import { createFieldCipher, parseKeyring } from './crypto/field-cipher.ts';
import { createKeyedHasher } from './crypto/keyed-hash.ts';
import { consoleOtpSender, noopOtpSender, type OtpSender } from './providers/otp.ts';
import { createRateLimiter } from './rate-limit/rate-limiter.ts';
import { randomInt } from 'node:crypto';

/** Shared infrastructure built once from the environment and handed to modules by the composition root. */
export function createPlatformServices<DB>(
  env: Env,
  db: Kysely<DB>,
  overrides: { otpSender?: OtpSender } = {},
) {
  const fixedCode = env.OTP_PROVIDER === 'dev-fixed' ? env.OTP_DEV_FIXED_CODE : undefined;
  return {
    cipher: createFieldCipher(parseKeyring(env.FIELD_ENCRYPTION_KEYS)),
    hasher: createKeyedHasher(Buffer.from(env.BLIND_INDEX_KEY, 'base64')),
    rateLimiter: createRateLimiter(db),
    audit: createAuditLog(db.withTables<AuditTables>() as unknown as Kysely<AuditTables>),
    otpSender: overrides.otpSender ?? (fixedCode ? noopOtpSender() : consoleOtpSender()),
    generateOtpCode: fixedCode ? () => fixedCode : () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    otpSendLimitPerIpHour: env.OTP_SEND_LIMIT_PER_IP_PER_HOUR,
    // Staging is invite-only (D-172): sign-in codes go only to these numbers.
    otpAllowedPhones: env.STAGING_ALLOWED_PHONES
      ? new Set(env.STAGING_ALLOWED_PHONES.split(',').map((p) => `+91${p.replace(/\D/g, '').slice(-10)}`))
      : undefined,
    otpVerifyLimitPerIpHour: env.OTP_VERIFY_LIMIT_PER_IP_PER_HOUR,
  };
}
