/**
 * Security headers for the web origins (architecture.md §9). The API under /api sets its own stricter set.
 * The Content-Security-Policy is per request (nonce-based), built by `contentSecurityPolicy` in each app's
 * proxy.ts; these static headers apply to every response.
 */
export function securityHeaders(options: { isDev: boolean; noIndex?: boolean }) {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
    ...(options.isDev
      ? []
      : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
    ...(options.noIndex ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
  ];
}

/**
 * Strict, nonce-based CSP (resolves R-51): no 'unsafe-inline' for scripts or styles. 'strict-dynamic' lets
 * nonce'd framework scripts load their chunks. Development additionally needs 'unsafe-eval' (React debugging)
 * and websocket connections (hot reload).
 */
export const MAP_TILES_ORIGIN = 'https://tiles.openfreemap.org';

export function contentSecurityPolicy(options: {
  nonce: string;
  isDev: boolean;
  paymentCheckout?: boolean;
  /** Map tiles, sprites and fonts (OpenFreeMap, D-174) and MapLibre's worker from our own origin. */
  maps?: boolean;
}): string {
  const { nonce, isDev } = options;
  // Customer web only: the payment provider's checkout runs in its own iframe (D-122). checkout.js itself is loaded
  // by our nonce'd bundle and is allowed through 'strict-dynamic'.
  const frames = options.paymentCheckout
    ? ['frame-src https://api.razorpay.com https://checkout.razorpay.com']
    : [];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' blob: data:${options.maps ? ` ${MAP_TILES_ORIGIN}` : ''}`,
    "font-src 'self'",
    `connect-src 'self'${options.maps ? ` ${MAP_TILES_ORIGIN}` : ''}${isDev ? ' ws:' : ''}`,
    // With 'strict-dynamic' a worker would fall back to script-src and lose 'self'; allow our own worker files.
    ...(options.maps ? ["worker-src 'self' blob:"] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...frames,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
