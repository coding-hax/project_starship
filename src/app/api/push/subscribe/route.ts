import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { authErrorResponse } from '@/auth/auth-response';
import { requireUser } from '@/auth/session';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';

/**
 * Upsert per endpoint (not per device): the browser may hand back the same
 * endpoint again (permission re-granted, SW re-registered) and this must stay
 * idempotent rather than accumulate duplicate rows.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const body = await request.json().catch(() => null);
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent : null;

  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  await db
    .insert(pushSubscriptions)
    .values({ id: uuidv7(), userId: user.userId, endpoint, p256dh, auth, userAgent })
    .onConflictDoUpdate({
      // On `(user_id, endpoint)`, not on the endpoint alone: a browser shared by
      // two accounts hands back the same endpoint, and each account keeps its
      // own row instead of one stealing the other's (ADR-0031).
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: { p256dh, auth, userAgent, lastUsedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
