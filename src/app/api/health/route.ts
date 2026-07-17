import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db';

// Never cached: the post-deploy smoke compares `version` against the deploy SHA to
// prove it measured the NEW deployment, not a stale CDN copy.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg needs the Node runtime, not Edge

/** Public liveness probe — no requireOwner(), it only leaks DB-up + the already-public commit SHA. */
export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { ok: false, version },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
