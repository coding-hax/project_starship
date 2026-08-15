import withSerwistInit from '@serwist/next';
import type { NextConfig } from 'next';

/**
 * The nonce-based CSP (issue #753) lives in src/middleware.ts — it needs a fresh
 * value per response, which this static list of headers() can't carry. These five
 * are the ones with no per-request state and no breakage risk.
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
  // Since #123 the Einstellungen entry lives in the top-right header, so top-right now
  // collides too. With the bottom bar and both header corners taken there is no free
  // corner in both viewports; under E2E the dev-only badge is simply turned off so it
  // can never sit on a real control.
  devIndicators: process.env.NEXT_PUBLIC_E2E === '1' ? false : { position: 'top-right' },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Habits moved to their own tab (issue #123), which was then renamed from
  // "Gewohnheiten" to "Routinen" (issue #655). Permanent so bookmarks, an already-open
  // tab, and the service worker's cached shell all still land in the right place.
  //
  // /heute/gewohnheiten points straight at the current route rather than hopping via
  // /gewohnheiten: a chain of two permanent redirects is one cached 308 per hop, and
  // the intermediate one is exactly what an old service worker may already hold.
  //
  // "Heute" was renamed to "Übersicht" (issue #161), same reasoning: an
  // installed PWA's start_url, old bookmarks, and open tabs must keep working.
  async redirects() {
    return [
      { source: '/heute/gewohnheiten', destination: '/routinen', permanent: true },
      { source: '/gewohnheiten', destination: '/routinen', permanent: true },
      { source: '/heute', destination: '/uebersicht', permanent: true },
    ];
  },
};

export default withSerwist(nextConfig);
