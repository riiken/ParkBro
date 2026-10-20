import type { NextConfig } from 'next';
import { securityHeaders } from '@parkbro/config/security-headers';

const isDev = process.env.NODE_ENV !== 'production';
// Same-origin API (D-033): /api/* on this origin reaches the API service, so session cookies stay first-party.
// In deployed environments the edge does this routing; the rewrite keeps local development identical.
// Render injects the API's private host:port (render.yaml) as API_INTERNAL_HOSTPORT.
const apiOrigin =
  process.env.API_INTERNAL_URL ??
  (process.env.API_INTERNAL_HOSTPORT
    ? `http://${process.env.API_INTERNAL_HOSTPORT}`
    : 'http://127.0.0.1:4101');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev-only indicator can't load its styles under our nonce CSP and shows as an empty box.
  devIndicators: false,
  transpilePackages: ['@parkbro/contracts', '@parkbro/config', '@parkbro/web-kit'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({ isDev, noIndex: process.env.PARKBRO_STAGING === 'true' }),
      },
    ];
  },
};

export default config;
