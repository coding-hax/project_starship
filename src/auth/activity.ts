import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { userActivityDays, users } from '@/db/schema';

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
