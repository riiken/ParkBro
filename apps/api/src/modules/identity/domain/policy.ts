/** Identity policy constants (trust-and-safety.md §3 V-PHONE, §5; architecture.md §9). */
export const OTP_TTL_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const REGISTRATION_TICKET_TTL_MINUTES = 15;
export const ADMIN_TOTP_TICKET_TTL_MINUTES = 5;
export const TICKET_MAX_ATTEMPTS = 5;

export const SESSION_POLICY = {
  USER: { idleDays: 30, absoluteDays: 90 },
  ADMIN: { idleMinutes: 60, absoluteHours: 8 },
} as const;
/** Sliding expiry is written at most this often per session, to avoid a DB write on every request. */
export const SESSION_TOUCH_INTERVAL_MINUTES = 5;

/** Version of the Terms + Privacy notice users accept at registration (DPDP consent records). */
export const CURRENT_NOTICE_VERSION = 'pilot-2026-10';

export const RATE_LIMITS = {
  otpSendPerPhone30s: { limit: 1, windowSeconds: 30 },
  otpSendPerPhoneHour: { limit: 5, windowSeconds: 3600 },
  otpSendPerIpHour: { limit: 20, windowSeconds: 3600 },
  otpVerifyPerIpHour: { limit: 60, windowSeconds: 3600 },
  totpPerUserHour: { limit: 10, windowSeconds: 3600 },
} as const;
