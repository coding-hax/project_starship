import { isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { reminderPrefs, reminderSends } from '@/db/schema';
import { dueSlots } from '@/push/schedule';
import { sendPushToAll, type PushPayload } from '@/push/send';
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
  build(now: Date): Promise<PushPayload | null>;
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
export async function loadReminderPrefs(): Promise<Map<string, ReminderPref>> {
  const rows = await db.select().from(reminderPrefs).where(isNull(reminderPrefs.deletedAt));
  return new Map(rows.map((row) => [row.kind, { enabled: row.enabled, times: row.times as string[] }]));
}

/**
 * Runs once per cron tick (issue #239). Order is deliberate: `build()` first, the
 * ON-CONFLICT lock second, `sendPushToAll` last. A `build() -> null` ("nothing to
 * report") must never write a lock row — otherwise a reminder that has something to
 * say later the same day would find the slot already claimed and stay silent for
 * good. The lock itself is `INSERT ... ON CONFLICT DO NOTHING`, not a
 * SELECT-then-INSERT, because the scheduled run and a manual `workflow_dispatch`
 * kick can race each other.
 */
export async function sendDueReminders(
  now: Date,
  kinds: ReminderKind[] = reminderKinds,
  loadPrefs: () => Promise<Map<string, ReminderPref>> = loadReminderPrefs,
): Promise<SendDueRemindersResult> {
  const prefs = await loadPrefs();

  const slots = dueSlots(
    now,
    kinds.map(({ kind, times }) => {
      const pref = prefs.get(kind);
      if (!pref) return { kind, times };
      return { kind, times: pref.enabled ? pref.times : [] };
    }),
  );

  const sent: string[] = [];
  const skipped: string[] = [];

  for (const { kind, slot, dateKey } of slots) {
    const source = kinds.find((candidate) => candidate.kind === kind);
    if (!source) continue;

    const payload = await source.build(now);
    if (payload === null) {
      skipped.push(kind);
      continue;
    }

    const claimed = await db
      .insert(reminderSends)
      .values({ id: uuidv7(), kind, sendDate: dateKey, slot })
      .onConflictDoNothing()
      .returning({ id: reminderSends.id });

    if (claimed.length === 0) {
      // Another run (or the same one, retried) already sent this slot today.
      skipped.push(kind);
      continue;
    }

    await sendPushToAll(payload);
    sent.push(kind);
  }

  return { sent, skipped };
}
