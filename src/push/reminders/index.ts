import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { reminderSends } from '@/db/schema';
import { dueSlots } from '@/push/schedule';
import { sendPushToAll, type PushPayload } from '@/push/send';

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

const reminderKinds: ReminderKind[] = [];

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
): Promise<SendDueRemindersResult> {
  const slots = dueSlots(
    now,
    kinds.map(({ kind, times }) => ({ kind, times })),
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
