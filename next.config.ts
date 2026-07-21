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
  // @serwist/next defaults to a full page reload on the `online` event. That
  // fights local-first (ARCHITECTURE.md: reconnect already triggers a quiet
  // sync via src/local/sync.ts's own `online` listener) and would blow away
  // whatever is open in the UI the moment connectivity returns.
  reloadOnOnline: false,
});

const nextConfig: NextConfig = {
  // A stray lockfile further up the tree makes Next guess the wrong workspace root.
  outputFileTracingRoot: import.meta.dirname,
  // Default bottom-left badge sits on top of the mobile bottom nav (#26) — dev-only,
  // but it broke real clicks on the nav links while running against `pnpm dev`.
  devIndicators: { position: 'top-right' },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Habits moved to their own tab at /gewohnheiten (issue #123). Permanent so
  // bookmarks, an already-open tab, and the service worker's cached shell all
  // still land in the right place.
  async redirects() {
    return [{ source: '/heute/gewohnheiten', destination: '/gewohnheiten', permanent: true }];
  },
};

export default withSerwist(nextConfig);
