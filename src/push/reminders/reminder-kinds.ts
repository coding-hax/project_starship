/**
 * Metadata shared between the settings panel and the cron (issue #244, "M3-T5").
 * `tasks-due.ts`/`habits-open.ts` carry only `kind`/`times`/`build` — no label, since
 * nothing needed one before this ticket. Kept here rather than on those modules so
 * `reminders/index.ts` and `push-panel.tsx` read the same defaults and never drift.
 */
export interface ReminderKindMeta {
  kind: string;
  label: string;
  defaultTimes: string[];
}

export const REMINDER_KINDS: ReminderKindMeta[] = [
  { kind: 'tasks-due', label: 'Fällige Aufgaben', defaultTimes: ['07:00'] },
  { kind: 'habits-open', label: 'Offene Routinen', defaultTimes: ['20:00'] },
];

if (process.env.NEXT_PUBLIC_E2E === '1') {
  REMINDER_KINDS.push({ kind: 'e2e-smoke', label: 'E2E-Test', defaultTimes: ['00:00'] });
}
