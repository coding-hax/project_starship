import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireOwner } from '@/auth/session';
import { sendDueReminders } from '@/push/reminders';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg + web-push are node-only (ADR-0010)

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Fixed-length digest compare — no early-exit length leak on the raw secret. */
function safeEqual(a: string, b: string): boolean {
  const digestA = sha256(a);
  const digestB = sha256(b);
  return timingSafeEqual(digestA, digestB);
}

async function hasValidOwnerSession(): Promise<boolean> {
  try {
    await requireOwner();
    return true;
  } catch {
    return false;
  }
}

/**
 * Triggered by the GitHub-Actions cron (`Authorization: Bearer <REMINDER_SECRET>`)
 * and, for a manual kick, by a signed-in owner — same auth shape as
 * `/api/garmin-sync` (ADR-0011): a cron run carries no session, so `requireOwner()`
 * alone would lock it out.
 */
export async function POST(request: Request) {
  const secret = process.env.REMINDER_SECRET;
  if (!secret) {
    // Never falls open: no secret configured means the endpoint is unusable, not
    // "owner session only".
    return NextResponse.json({ error: 'REMINDER_SECRET is not set' }, { status: 503 });
  }

  const header = request.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const authorized = (bearer !== null && safeEqual(bearer, secret)) || (await hasValidOwnerSession());

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The kinds and their outcome, never an endpoint or a key (AC9).
  const result = await sendDueReminders(new Date());
  console.log('[push/reminders]', result);
  return NextResponse.json(result);
}
