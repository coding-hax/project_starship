'use client';

import { useSyncExternalStore } from 'react';
import { shiftDayKey, todayKey } from './entry';

/**
 * The day currently shown by the journal (issue #1050) — same tiny module-store
 * shape as `journal-view-mode.ts`'s search flag: the eyebrow's chevrons
 * (`journal-day-nav.tsx`, outside the gate, in the page's own `PageHead`) and
 * the swipeable day card + entry sheet (inside the gate, `journal-editor.tsx`)
 * live in different subtrees, so a shared module store — not lifted React
 * state — is what lets one change what the others read.
 *
 * No `pushState`/route param (owner decision 5 in #1046, unlike
 * `/wetter/[datum]`'s `WeatherDayScreen`): the shown day lives only here and
 * never survives a reload, on purpose — `/journal` always opens back onto
 * today.
 */
let overrideDate: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot(): string {
  return overrideDate ?? todayKey();
}

/** The server can't reliably know "today" either (same reasoning as
 * `TodayLongDate`) — callers fall back to a neutral placeholder for the one
 * render before the client's own snapshot lands. */
function getServerSnapshot(): null {
  return null;
}

function goTo(date: string) {
  const next = date === todayKey() ? null : date;
  if (next === overrideDate) return;
  overrideDate = next;
  notify();
}

export interface JournalDayNav {
  /** `null` only for the one render before hydration settles. */
  date: string | null;
  /** `null` at today (AK6) — there is no day beyond it to switch to. */
  nextDate: string | null;
  previousDate: string | null;
  /** No bound backward (AK6) — always a real date once `date` itself is known. */
  goTo: (date: string) => void;
}

export function useJournalDayNav(): JournalDayNav {
  const date = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const nextDate = date === null ? null : date === todayKey() ? null : shiftDayKey(date, 1);
  const previousDate = date === null ? null : shiftDayKey(date, -1);
  return { date, nextDate, previousDate, goTo };
}
