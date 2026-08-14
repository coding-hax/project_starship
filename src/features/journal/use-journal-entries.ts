'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';
import { loadSearchableJournalEntries } from './journal-search-cache';
import { logJournalQueryError } from './log-query-error';
import type { JournalSearchEntry } from './search';

export interface JournalDayGroup {
  dayKey: string;
  entries: JournalSearchEntry[];
}

function groupByDay(entries: JournalSearchEntry[]): JournalDayGroup[] {
  const byDay = new Map<string, JournalSearchEntry[]>();
  for (const entry of entries) {
    const day = byDay.get(entry.entryDate);
    if (day) {
      day.push(entry);
    } else {
      byDay.set(entry.entryDate, [entry]);
    }
  }
  for (const day of byDay.values()) {
    day.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dayKey, dayEntries]) => ({ dayKey, entries: dayEntries }));
}

/**
 * Every entry, grouped by day, newest day first and newest entry first within
 * a day (AK3, #700/#701 — owner decision "A": no 30-day window, search hits
 * can be older than that and #700 AK7's jump needs a rendered day either way).
 * Sourced from the same session cache search reads from
 * (`loadSearchableJournalEntries`, same as use-journal-search-entries.ts) — no
 * new decrypt/key path (AK7, #700 Q2). Re-groups whenever `journal_entries`
 * changes, same `liveQuery` pattern as that hook. `undefined` before the
 * first pass.
 */
export function useJournalEntries(): JournalDayGroup[] | undefined {
  const [groups, setGroups] = useState<JournalDayGroup[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const subscription = liveQuery(() =>
      db.records.where('table').equals('journal_entries').toArray(),
    ).subscribe({
      next: () => {
        void loadSearchableJournalEntries()
          .then((loaded) => {
            if (!cancelled) setGroups(groupByDay(loaded));
          })
          .catch(() => {
            logJournalQueryError('journal entries live query failed');
            if (!cancelled) setGroups([]);
          });
      },
      error: () => logJournalQueryError('journal entries live query failed'),
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return groups;
}
