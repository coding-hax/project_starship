import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireOwner } from '@/auth/session';
import { GarminBootstrapRequired } from '@/features/garmin/tokens';
import { syncActivities } from '@/features/garmin/sync-activities';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg needs the Node runtime, not Edge

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
 * Triggered by the GitHub-Actions cron (`Authorization: Bearer <GARMIN_SYNC_SECRET>`)
 * and, for a manual kick, by a signed-in owner (ADR-0011) — the one deliberate
 * exception to the CODEMAP invariant "every route checks requireOwner()": a cron
 * run carries no session. Precedent: `/api/health`.
 */
export async function POST(request: Request) {
  const secret = process.env.GARMIN_SYNC_SECRET;
  if (!secret) {
    // Never falls open: no secret configured means the endpoint is unusable, not
    // "owner session only".
    return NextResponse.json({ error: 'GARMIN_SYNC_SECRET is not set' }, { status: 503 });
  }

  const header = request.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const authorized = (bearer !== null && safeEqual(bearer, secret)) || (await hasValidOwnerSession());

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get('days');
  let days: number | undefined;
  if (raw !== null) {
    days = Number.parseInt(raw, 10);
    if (!Number.isInteger(days) || days <= 0) {
      return NextResponse.json({ error: 'days must be a positive integer' }, { status: 400 });
    }
  }

  try {
    const result = await syncActivities({ days });
    // Counters and nothing else — never a token, a coordinate, or a raw Garmin
    // response body (ADR-0011).
    console.log('[garmin-sync]', result);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GarminBootstrapRequired) {
      // Visible and final: no write happened, and this route never retries a login.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('[garmin-sync] failed:', error instanceof Error ? error.constructor.name : typeof error);
    throw error;
  }
}
