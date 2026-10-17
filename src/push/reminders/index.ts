import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { reminderPrefs, reminderSends, users } from '@/db/schema';
import { dueSlots } from '@/push/schedule';
import { sendPushToUser, type PushPayload } from '@/push/send';
import { collectDueEventReminders } from './events-due';
import { habitsOpen } from './habits-open';
import { interactionLimit } from './interaction-limit';
import { tasksDue } from './tasks-due';

/**
 * One reminder kind. `times` is a list, not a single `'HH:MM'`, because T5 will let
 * a kind fire more than once a day — this ticket registers kinds with exactly one
 * entry, but `dueSlots` (src/push/schedule.ts) already treats every entry as its own
 * lockable slot.
 */
export interface ReminderKind {
  kind: string;
  times: string[];
  /** Builds the payload for **one** account, or null when there is nothing to say. */
  build(now: Date, userId: string): Promise<PushPayload | null>;
  /**
   * Set for a reminder about the installation rather than about an account's own
   * data (`interaction-limit`): it runs for admins only, since nobody else can
   * act on it. Everything else runs for every non-blocked account.
   */
  adminOnly?: boolean;
}

const reminderKinds: ReminderKind[] = [tasksDue, habitsOpen, interactionLimit];

if (process.env.NEXT_PUBLIC_E2E === '1') {
  reminderKinds.push({
    kind: 'e2e-smoke',
    // '00:00' so this is due at any wall-clock time the suite happens to run at —
    // the real reminder kinds (T3/T4) get real times, this one only proves the
    // cron -> lock -> push pipeline works end to end (same pattern as the
    // NEXT_PUBLIC_E2E hooks in src/app/sw.ts from #122).
    times: ['00:00'],
    build: async () => ({ title: 'Starship', body: 'E2E-Testerinnerung', url: '/' }),
  });
}

export interface SendDueRemindersResult {
  sent: string[];
  skipped: string[];
}

export interface ReminderPref {
  enabled: boolean;
  times: string[];
}

/**
 * Stored overrides for reminder kinds (issue #244, "M3-T5"), keyed by `kind`. A
 * kind absent from the map keeps its registry default (`ReminderKind.times`,
 * always enabled) — see the doc comment on `reminderPrefs` in src/db/schema.ts
 * for why an empty `times` array must not fall back to that default too.
 */
export async function loadReminderPrefs(userId: string): Promise<Map<string, ReminderPref>> {
  const rows = await db
    .select()
    .from(reminderPrefs)
    .where(and(eq(reminderPrefs.userId, userId), isNull(reminderPrefs.deletedAt)));
  return new Map(rows.map((row) => [row.kind, { enabled: row.enabled, times: row.times as string[] }]));
}

/** Accounts a cron tick delivers to: every account that is not locked (ADR-0031). */
export async function loadDeliverableUsers(): Promise<Array<{ id: string; role: 'admin' | 'user' }>> {
  return db.select({ id: users.id, role: users.role }).from(users).where(isNull(users.blockedAt));
}

/**
 * Runs once per cron tick (issue #239), now **once per account** (ADR-0031): the
 * outer loop is over every non-blocked account, everything inside it is the
 * unchanged single-account logic, scoped by `userId`.
 *
 * Order inside an account is deliberate: `build()` first, the ON-CONFLICT lock
 * second, the send last. A `build() -> null` ("nothing to report") must never
 * write a lock row — otherwise a reminder that has something to say later the
 * same day would find the slot already claimed and stay silent for good. The
 * lock itself is `INSERT ... ON CONFLICT DO NOTHING`, not a SELECT-then-INSERT,
 * because the scheduled run and a manual `workflow_dispatch` kick can race each
 * other; its unique index carries `user_id`, so two accounts can both claim the
 * same slot on the same day and one account still never twice.
 *
 * A failing account does not take the tick down with it: its error is logged by
 * account id and kind — never by payload, which is the account's own data — and
 * the loop moves on. One person's broken row must not cost everybody else their
 * reminders.
 */
export async function sendDueReminders(
  now: Date,
  kinds: ReminderKind[] = reminderKinds,
  loadPrefs: (userId: string) => Promise<Map<string, ReminderPref>> = loadReminderPrefs,
  collectEvents: (
    now: Date,
    userId: string,
  ) => ReturnType<typeof collectDueEventReminders> = collectDueEventReminders,
  loadUsers: () => Promise<Array<{ id: string; role: 'admin' | 'user' }>> = loadDeliverableUsers,
): Promise<SendDueRemindersResult> {
  const sent: string[] = [];
  const skipped: string[] = [];

  for (const user of await loadUsers()) {
    try {
      const result = await sendDueRemindersForUser(now, user, kinds, loadPrefs, collectEvents);
      sent.push(...result.sent);
      skipped.push(...result.skipped);
    } catch (error) {
      console.error('[reminders] account skipped', {
        userId: user.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return { sent, skipped };
}

async function sendDueRemindersForUser(
  now: Date,
  user: { id: string; role: 'admin' | 'user' },
  kinds: ReminderKind[],
  loadPrefs: (userId: string) => Promise<Map<string, ReminderPref>>,
  collectEvents: (now: Date, userId: string) => ReturnType<typeof collectDueEventReminders>,
): Promise<SendDueRemindersResult> {
  const applicable = kinds.filter((kind) => !kind.adminOnly || user.role === 'admin');
  const prefs = await loadPrefs(user.id);

  const slots = dueSlots(
    now,
    applicable.map(({ kind, times }) => {
      const pref = prefs.get(kind);
      if (!pref) return { kind, times };
      return { kind, times: pref.enabled ? pref.times : [] };
    }),
  );

  const sent: string[] = [];
  const skipped: string[] = [];

  for (const { kind, slot, dateKey } of slots) {
    const source = applicable.find((candidate) => candidate.kind === kind);
    if (!source) continue;

    const payload = await source.build(now, user.id);
    if (payload === null) {
      skipped.push(kind);
      continue;
    }

    const claimed = await db
      .insert(reminderSends)
      .values({ id: uuidv7(), userId: user.id, kind, sendDate: dateKey, slot })
      .onConflictDoNothing()
      .returning({ id: reminderSends.id });

    if (claimed.length === 0) {
      // Another run (or the same one, retried) already sent this slot today.
      skipped.push(kind);
      continue;
    }

    await sendPushToUser(user.id, payload);
    sent.push(kind);
  }

  // Second phase (issue #558, S7 of #473): per-event "15 Minuten vorher"
  // reminders. These are a moving point in time per event, not a fixed daily
  // slot, so they bypass `dueSlots`/`ReminderKind` entirely — same
  // collect -> lock -> send order as the loop above, just keyed on
  // `event-reminder` + the occurrence's own lock slot instead of a kind's name.
  for (const { lockSlot, sendDate, payload } of await collectEvents(now, user.id)) {
    const claimed = await db
      .insert(reminderSends)
      .values({ id: uuidv7(), userId: user.id, kind: 'event-reminder', sendDate, slot: lockSlot })
      .onConflictDoNothing()
      .returning({ id: reminderSends.id });

    if (claimed.length === 0) {
      skipped.push('event-reminder');
      continue;
    }

    await sendPushToUser(user.id, payload);
    sent.push('event-reminder');
  }

  return { sent, skipped };
}
