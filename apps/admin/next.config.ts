import type { NextConfig } from 'next';
import { securityHeaders } from '@parkbro/config/security-headers';

const isDev = process.env.NODE_ENV !== 'production';
// Separate origin for admin (D-033): its own /api route and __Host- admin cookie; never indexed.
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
    return [{ source: '/:path*', headers: securityHeaders({ isDev, noIndex: true }) }];
  },
};

export default config;
