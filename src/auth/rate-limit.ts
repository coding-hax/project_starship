import { and, eq, lt, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { authRateLimits } from '@/db/schema';

/**
 * Budgets for the unauthenticated auth endpoints (issue #755). `options` covers
 * `login/options`, `register/options` and `register/verify` — a legit ceremony is
 * 1-2 calls, far under the limit. `recovery` is its own, stricter budget counted
 * only on a *failed* recovery-code attempt (AC3), never on a successful one.
 */
export const AUTH_RATE_LIMITS = {
  options: { limit: 20, windowMs: 5 * 60 * 1000 },
  recovery: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

type Bucket = keyof typeof AUTH_RATE_LIMITS;

/**
 * `x-real-ip`, else the rightmost `x-forwarded-for` hop — the one a trusting proxy
 * appends itself, which a client-prepended fake entry cannot lower — else the fixed
 * `unknown` bucket. Spoofable without a proxy in front (no headers at all means every
 * caller shares `unknown`, so the limit degrades to global rather than per-sender) —
 * accepted for a single-user tool; see the PR for the full tradeoff.
 */
export function clientKey(request: Request): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return 'unknown';
}

/** Fixed-window boundary, aligned to the epoch so every caller computes the same value. */
function currentWindowStart(cfg: { windowMs: number }, now: number): Date {
  return new Date(Math.floor(now / cfg.windowMs) * cfg.windowMs);
}

function retryAfterResponse(cfg: { windowMs: number }, windowStart: Date, now: number): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + cfg.windowMs - now) / 1000));
  return NextResponse.json(
    { error: 'Zu viele Anfragen.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/** Sweeps windows older than the current one for this bucket — mirrors `storeChallenge`. */
async function pruneStale(bucket: Bucket, windowStart: Date): Promise<void> {
  await db
    .delete(authRateLimits)
    .where(and(eq(authRateLimits.bucket, bucket), lt(authRateLimits.windowStart, windowStart)));
}

/**
 * Counts this request against `bucket`'s window and blocks once the budget is
 * spent. A DB failure fails open (returns `null`, request proceeds) — a tool that
 * locks its single user out is worse than one that runs briefly unthrottled.
 */
export async function enforce(request: Request, bucket: Bucket): Promise<NextResponse | null> {
  const cfg = AUTH_RATE_LIMITS[bucket];
  try {
    const key = clientKey(request);
    const now = Date.now();
    const windowStart = currentWindowStart(cfg, now);

    await pruneStale(bucket, windowStart);

    const [row] = await db
      .insert(authRateLimits)
      .values({ id: uuidv7(), bucket, key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [authRateLimits.bucket, authRateLimits.key, authRateLimits.windowStart],
        set: { count: sql`${authRateLimits.count} + 1` },
      })
      .returning({ count: authRateLimits.count });

    if (row.count > cfg.limit) {
      return retryAfterResponse(cfg, windowStart, now);
    }
    return null;
  } catch {
    console.error('auth-rate-limit: db access failed, allowing request');
    return null;
  }
}

/**
 * Read-only check of the recovery budget — call before spending the attempt on
 * `verifyRecoveryCode`. Does not itself count anything; only `noteRecoveryFailure`
 * does, so a successful recovery never touches the budget (AC3).
 */
export async function recoveryBlocked(request: Request): Promise<NextResponse | null> {
  const cfg = AUTH_RATE_LIMITS.recovery;
  try {
    const key = clientKey(request);
    const now = Date.now();
    const windowStart = currentWindowStart(cfg, now);

    const [row] = await db
      .select({ count: authRateLimits.count })
      .from(authRateLimits)
      .where(
        and(
          eq(authRateLimits.bucket, 'recovery'),
          eq(authRateLimits.key, key),
          eq(authRateLimits.windowStart, windowStart),
        ),
      )
      .limit(1);

    if (row && row.count >= cfg.limit) {
      return retryAfterResponse(cfg, windowStart, now);
    }
    return null;
  } catch {
    console.error('auth-rate-limit: db access failed, allowing request');
    return null;
  }
}

/** Counts one failed recovery-code attempt against the recovery budget. */
export async function noteRecoveryFailure(request: Request): Promise<void> {
  const cfg = AUTH_RATE_LIMITS.recovery;
  try {
    const key = clientKey(request);
    const windowStart = currentWindowStart(cfg, Date.now());

    await pruneStale('recovery', windowStart);

    await db
      .insert(authRateLimits)
      .values({ id: uuidv7(), bucket: 'recovery', key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [authRateLimits.bucket, authRateLimits.key, authRateLimits.windowStart],
        set: { count: sql`${authRateLimits.count} + 1` },
      });
  } catch {
    console.error('auth-rate-limit: db access failed, count not recorded');
  }
}
