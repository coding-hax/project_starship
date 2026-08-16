import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/auth/session-cookie';

const PROTECTED_PREFIXES = [
  '/uebersicht',
  '/aufgaben',
  '/kalender',
  '/routinen',
  '/journal',
  '/aktivitaeten',
  '/einstellungen',
  '/wetter',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

// Edge runtime: no `Buffer`/`node:crypto`, only the Web Crypto globals.
function buildNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

// No 'strict-dynamic': Next's own chunks load via `src="/_next/…"` ('self'), and its
// inline Flight scripts pick up the nonce automatically once it rides the request
// header (see below) — so a script injected without the nonce is reliably blocked (AK5).
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // Next injects inline styles at runtime, and --font-scale (use-appearance.ts) is
    // set on <html> as an inline style — the nonce only covers script-src (AK2), so
    // this is a deliberate, scoped compromise rather than an oversight.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Auth check: cookie presence only, no DB access — this runs in the Edge runtime,
 * which session.ts cannot (next/headers cookies() aside, it also pulls drizzle and
 * node:crypto). The real check stays at the data layer: every `/api/sync/*` route
 * calls requireOwner() against Postgres. `/anmelden`, `/` and `/api/*` never redirect.
 *
 * CSP (production only, issue #753): dev needs 'unsafe-eval' for HMR and none of the
 * `mobile` project's specs expect a CSP, so the header is skipped there entirely
 * rather than run Report-Only. The nonce rides as a request header
 * (`content-security-policy`) so Next nonces its own inline Flight scripts, and as
 * `x-nonce` so `layout.tsx` can put it on the theme-bootstrap `<script>`; both carry
 * the same value the response header sends. Without threading it back onto the
 * request (`NextResponse.next({ request: { headers } })`), Next's own scripts would
 * render without the nonce and the CSP would block the app itself — a white page.
 */
export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);

  if (process.env.NODE_ENV === 'production') {
    const nonce = buildNonce();
    const csp = buildCsp(nonce);
    headers.set('content-security-policy', csp);
    headers.set('x-nonce', nonce);
  }

  if (isProtected(request.nextUrl.pathname) && !request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL('/anmelden', request.url));
  }

  const response = NextResponse.next({ request: { headers } });
  const csp = headers.get('content-security-policy');
  if (csp) response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Everything except static/build internals and the service worker script: a CSP on
  // sw.js would apply to its own scope and block its precache fetches via connect-src,
  // silently breaking offline (must stay excluded, hard requirement).
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf)$).*)',
  ],
};
