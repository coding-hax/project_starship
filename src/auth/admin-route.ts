import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { authErrorResponse } from './auth-response';
import { NotAdminError, requireAdmin, type SessionUser } from './session';
import { relyingParty } from './webauthn';

export type AdminGuardResult = { admin: SessionUser } | { error: NextResponse };

/**
 * A path that matches no route anywhere in this app — the redirect target
 * `guardAdmin()` and the `(admin)` layout share (AK5). `notFound()` thrown from
 * a MATCHED segment (a route handler as much as a layout) still answers with
 * that segment's own prefetch manifest/script preloads, so its response is
 * never byte-identical to a genuinely unmatched route — confirmed by e2e, a
 * few hundred bytes apart (Route Handlers go further: `notFound()` there
 * produces an EMPTY body, not even a rendered page). A redirect forces a fresh,
 * truly unmatched request instead, which Next renders exactly like any other
 * 404 — because, after the client follows the redirect, it is one.
 */
export const ADMIN_NOT_FOUND_PATH = '/__admin-existiert-nicht__';

/**
 * The one gate every route under `src/app/api/admin/` calls (#1224 AK2) —
 * `tests/admin-routes-guarded.test.ts` greps every route file for this name and
 * fails if one forgets it.
 *
 * `NotAdminError` redirects to `ADMIN_NOT_FOUND_PATH` instead of returning the
 * `{error:'not-found'}` JSON `authErrorResponse()` used to return (AK5): a
 * signed-in non-admin account must see `/api/admin/*` as indistinguishable from
 * a route that does not exist, byte-for-byte. `authErrorResponse()` still
 * carries 401 (no session) and 403 (blocked account) — those are not about
 * whether the route exists.
 *
 * `mutating: true` additionally requires the request's `Origin` to match this
 * deployment's own (AK6) — the one CSRF defence a cookie-based session has
 * without a token to check. GET never mutates, so it is exempt; every POST/
 * PATCH/DELETE under `/api/admin/*` must pass `mutating: true`.
 */
export async function guardAdmin(
  request: Request,
  { mutating }: { mutating: boolean },
): Promise<AdminGuardResult> {
  let admin: SessionUser;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof NotAdminError) redirect(ADMIN_NOT_FOUND_PATH);
    const response = authErrorResponse(error);
    if (response) return { error: response };
    throw error;
  }

  if (mutating && !assertSameOrigin(request)) {
    return { error: NextResponse.json({ error: 'forbidden-origin' }, { status: 403 }) };
  }

  return { admin };
}

function assertSameOrigin(request: Request): boolean {
  return request.headers.get('origin') === relyingParty().origin;
}
