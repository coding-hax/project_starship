import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { userActivityDays, userActivityWindows, users } from '@/db/schema';

/** Same window as `touchLastSeen`'s session-level throttle (session.ts) — one
 * write per account per hour, not one per request (AK3). */
const ACTIVITY_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Advances `users.last_seen_at` and records today in `user_activity_days`, both
 * throttled to at most once per hour per account (AK3) — the goal is an honest
 * "zuletzt aktiv"/"aktive Tage", not a write on the path every request takes.
 *
 * Mirrors `touchLastSeen` (session.ts): the `WHERE` guard on the `UPDATE` is the
 * actual, race-safe throttle; the JS check above it only spares the round trip
 * in the common case where nothing needs to happen. `user_activity_days` then
 * upserts on its `(user_id, day)` primary key (`ON CONFLICT DO NOTHING`), so a
 * second request inside the same open hour-window still only ever no-ops there.
 */
export async function recordActivity(userId: string, usersLastSeenAt: Date | null): Promise<void> {
  const throttleBoundary = new Date(Date.now() - ACTIVITY_THROTTLE_MS);
  if (usersLastSeenAt && usersLastSeenAt > throttleBoundary) return;

  await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(
      and(eq(users.id, userId), or(isNull(users.lastSeenAt), lt(users.lastSeenAt, throttleBoundary))),
    );

  await db
    .insert(userActivityDays)
    .values({ userId, day: sql`current_date` })
    .onConflictDoNothing();
}

/** Neon puts an inactive compute to sleep after ~5 minutes; the next request
 * wakes it again (#1233) — a fixed constant, not a call to the Neon API (AK4,
 * see the ticket's "Nicht-Ziele"). */
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

/** Rounds `now` down to the start of its 5-minute UTC window (AK1). */
export function currentWindowStart(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / ACTIVITY_WINDOW_MS) * ACTIVITY_WINDOW_MS);
}

/**
 * Deletes windows older than the 31-day retention (AK8) — no cron needed, the
 * reminder cron this would otherwise ride along with doesn't run yet (see the
 * ticket). Runs inside the same try/catch as every recorder below, so a prune
 * failure is as harmless as a record failure.
 */
async function pruneOldWindows(): Promise<void> {
  await db
    .delete(userActivityWindows)
    .where(lt(userActivityWindows.windowStart, sql`now() - interval '31 days'`));
}

/**
 * Records that `userId`'s account kept the compute awake during the current
 * 5-minute window (AK1) — one `INSERT ... ON CONFLICT DO NOTHING` on the
 * account-side partial unique index, no prior SELECT (every further request in
 * the same window is a DB-side no-op). Never throws (AK2): `requireUser()` calls
 * this on the path of every request, so a database hiccup here must not turn
 * into a failed request.
 */
export async function recordActivityWindow(userId: string): Promise<void> {
  try {
    await db
      .insert(userActivityWindows)
      .values({ userId, windowStart: currentWindowStart() })
      .onConflictDoNothing();
    await pruneOldWindows();
  } catch (error) {
    console.warn('[activity] recordActivityWindow failed', error);
  }
}

/**
 * Same as `recordActivityWindow`, for a system source that sits outside
 * `requireUser()` (AK3): `GET /api/health` (`deploy-probe`) and the cron path of
 * `POST /api/push/reminders` (`cron`). Upserts on the system-side partial unique
 * index instead of the account-side one; otherwise identical, including the
 * same never-throws contract and the same prune.
 */
export async function recordSystemWindow(source: 'cron' | 'deploy-probe'): Promise<void> {
  try {
    await db
      .insert(userActivityWindows)
      .values({ systemSource: source, windowStart: currentWindowStart() })
      .onConflictDoNothing();
    await pruneOldWindows();
  } catch (error) {
    console.warn('[activity] recordSystemWindow failed', error);
  }
}
