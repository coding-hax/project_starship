import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';
import { authErrorResponse } from './auth-response';
import { NotAdminError, requireAdmin, type SessionUser } from './session';
import { relyingParty } from './webauthn';

export type AdminGuardResult = { admin: SessionUser } | { error: NextResponse };

/**
 * The one gate every route under `src/app/api/admin/` calls (#1224 AK2) —
 * `tests/admin-routes-guarded.test.ts` greps every route file for this name and
 * fails if one forgets it.
 *
 * `NotAdminError` renders Next's default 404 via `notFound()` instead of the
 * `{error:'not-found'}` JSON `authErrorResponse()` used to return (AK5): a
 * signed-in non-admin account must see `/api/admin/*` as indistinguishable from
 * a route that does not exist, byte-for-byte, and only Next's own 404 can match
 * byte-for-byte what Next itself renders for an unknown path. `authErrorResponse()`
 * still carries 401 (no session) and 403 (blocked account) — those are not about
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
    if (error instanceof NotAdminError) notFound();
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
