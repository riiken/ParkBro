import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, generateNonce } from '@parkbro/config/security-headers';

/**
 * Per-request nonce CSP (resolves R-51). Next.js reads the nonce from the request's CSP header and applies it
 * to its own scripts and styles; pages render dynamically (root layout awaits connection()).
 */
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = contentSecurityPolicy({ nonce, isDev: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Not the API (it sets its own headers) or static assets.
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
