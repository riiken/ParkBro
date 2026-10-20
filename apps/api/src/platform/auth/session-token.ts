import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque session tokens (architecture.md §9, D-033): 256 random bits, sent only in a `__Host-` cookie,
 * stored server-side only as a SHA-256 hash (a DB leak does not yield usable sessions).
 * `__Host-` requires Secure, Path=/ and no Domain, so the cookie is bound to exactly one origin.
 */
export const USER_SESSION_COOKIE = '__Host-pb_session';
export const ADMIN_SESSION_COOKIE = '__Host-pb_admin';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

const TOKEN_BYTES = 32;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, unpadded

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
