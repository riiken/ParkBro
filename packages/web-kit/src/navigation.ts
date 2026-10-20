/**
 * Post-sign-in redirect target from a `next` query parameter, restricted to same-origin paths
 * (no open redirects: rejects absolute URLs, protocol-relative `//host`, backslash tricks and control chars).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/account'): string {
  if (!next || next.length > 512) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const url = new URL(next, 'https://same-origin.invalid');
    return url.origin === 'https://same-origin.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
