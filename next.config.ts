import withSerwistInit from '@serwist/next';
import type { NextConfig } from 'next';

/**
 * A strict, nonce-based CSP needs middleware injection in the App Router and is
 * tracked as its own ticket. These are the headers that carry no breakage risk.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

/**
 * Serwist plugs into webpack, and Next 16 builds with Turbopack by default — that
 * combination crashes the build (serwist#54). `pnpm build` therefore passes
 * `--webpack` explicitly. Do not "modernise" that flag away; the service worker,
 * and with it installability, silently disappears.
 */
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // A service worker in dev fights hot reload and caches stale code.
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withSerwist(nextConfig);
