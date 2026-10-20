import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { recordSystemWindow } from '@/auth/activity';
import { db } from '@/db';

// Never cached: the post-deploy smoke compares `version` against the deploy SHA to
// prove it measured the NEW deployment, not a stale CDN copy.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg needs the Node runtime, not Edge

/** Public liveness probe — no requireUser(), it only leaks DB-up + the already-public commit SHA. */
export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  try {
    await db.execute(sql`select 1`);
    // Health keeps the compute awake too, so it is its own source (#1233 AK3) —
    // never throws on its own (AK2), so it can't turn this into a 503.
    await recordSystemWindow('deploy-probe');
    return NextResponse.json({ ok: true, version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { ok: false, version },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
