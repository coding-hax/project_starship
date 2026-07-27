/**
 * Pure scheduling logic (issue #239) — no DB, no network, so it's Vitest-testable
 * without a database. `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' })`
 * does the DST work: 07:00 Berlin time stays 07:00 across both changeover dates,
 * because the offset conversion happens inside ICU, not by hand.
 */

export interface BerlinTime {
  /** Calendar day in Berlin time, `'YYYY-MM-DD'` — the dedup key, not a UTC day. */
  dateKey: string;
  /** Minutes since Berlin midnight, `0`–`1439`. */
  minutesOfDay: number;
}

const berlinFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function berlinNow(now: Date): BerlinTime {
  const parts = berlinFormatter.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)!.value;
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  const minutesOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return { dateKey, minutesOfDay };
}

/** A reminder kind's due times, `'HH:MM'` — a list because T5 will allow more than one. */
export interface SlotSource {
  kind: string;
  times: string[];
}

export interface DueSlot {
  kind: string;
  slot: string;
  dateKey: string;
}

function slotMinutes(slot: string): number {
  const [hour, minute] = slot.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Every (kind, slot) pair whose Berlin-time slot has arrived or passed on today's
 * Berlin calendar day. A run at 07:35 still returns the 07:00 slot (caught up late);
 * a run at 06:30 does not. There is no lookback across `dateKey` — a slot that never
 * fired yesterday is simply gone, not queued for today (see the module doc in
 * `src/push/reminders/index.ts` for why: the send lock is keyed on `send_date`).
 */
export function dueSlots(now: Date, kinds: SlotSource[]): DueSlot[] {
  const { dateKey, minutesOfDay } = berlinNow(now);
  const due: DueSlot[] = [];
  for (const { kind, times } of kinds) {
    for (const slot of times) {
      if (minutesOfDay >= slotMinutes(slot)) {
        due.push({ kind, slot, dateKey });
      }
    }
  }
  return due;
}
