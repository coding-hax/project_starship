import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';

/** Idempotent: deleting an endpoint that's already gone is still success. */
export async function POST(request: Request) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const body = await request.json().catch(() => null);
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));

  return NextResponse.json({ ok: true });
}
