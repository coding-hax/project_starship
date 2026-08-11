import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/auth/session-cookie';

/**
 * Optimistic check only: cookie presence, no DB access — this runs in the Edge
 * runtime, which session.ts cannot (next/headers cookies() aside, it also pulls
 * drizzle and node:crypto). The real check stays at the data layer: every
 * `/api/sync/*` route calls requireOwner() against Postgres.
 */
export function middleware(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  return NextResponse.redirect(new URL('/anmelden', request.url));
}

export const config = {
  matcher: [
    '/uebersicht/:path*',
    '/aufgaben/:path*',
    '/kalender/:path*',
    '/routinen/:path*',
    '/journal/:path*',
    '/aktivitaeten/:path*',
    '/einstellungen/:path*',
    '/wetter/:path*',
  ],
};
