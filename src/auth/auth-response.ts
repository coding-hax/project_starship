import { NextResponse } from 'next/server';
import { AccountBlockedError, NotAdminError, UnauthorizedError } from './session';

/**
 * The one place `requireUser()`'s (and `requireAdmin()`'s) throws become HTTP
 * (ADR-0031). Every route uses it, so the client can rely on the distinction
 * everywhere instead of per endpoint:
 *
 * - 401 `{ error: 'Unauthorized' }` — no session. The client wipes its local
 *   database and goes to /anmelden.
 * - 403 `{ error: 'blocked' }` — session fine, account locked. The client stops
 *   syncing, shows the lock notice, and **keeps** its data (#1201, S2).
 * - 404 `{ error: 'not-found' }` — session fine, not an admin account (S4,
 *   #1203 AK1). Not 403: the existence of `/api/admin/*` is not information a
 *   non-admin account gets to have.
 *
 * Returns `null` for anything else, so the caller rethrows rather than turning a
 * real bug into a 401.
 */
export function authErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AccountBlockedError) {
    return NextResponse.json({ error: 'blocked' }, { status: 403 });
  }
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof NotAdminError) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  return null;
}
