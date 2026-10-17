import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireUser } from '@/auth/session';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';

/** Idempotent: deleting an endpoint that's already gone is still success. */
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
  if (typeof endpoint !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, user.userId), eq(pushSubscriptions.endpoint, endpoint)),
    );

  return NextResponse.json({ ok: true });
}
