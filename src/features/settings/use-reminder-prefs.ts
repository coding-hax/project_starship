'use client';

import { useCallback, useMemo } from 'react';
import { mutate } from '@/local/outbox';
import { useLiveTable } from '@/local/use-live-table';
import { REMINDER_KINDS } from '@/push/reminders/reminder-kinds';

interface ReminderPrefRow {
  id: string;
  kind: string;
  enabled: boolean;
  times: string[];
}

/**
 * Merged view for one reminder kind — the registry default (src/push/reminders/
 * reminder-kinds.ts) for a kind with no stored row yet, the stored row otherwise.
 * `persisted` distinguishes the two so nothing here ever needs to know whether a
 * row exists to render correctly (issue #244 AC5: opening the panel never writes).
 */
export interface ReminderPrefView {
  kind: string;
  label: string;
  enabled: boolean;
  times: string[];
  persisted: boolean;
}

function toReminderPrefRow(id: string, data: Record<string, unknown>): ReminderPrefRow {
  return {
    id,
    kind: typeof data.kind === 'string' ? data.kind : '',
    enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
    times: Array.isArray(data.times) ? data.times.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** Duplicate times entered twice merge silently, no error (plan decision for #244). */
function dedupeSorted(times: string[]): string[] {
  return [...new Set(times)].sort();
}

/**
 * Reads reminder preferences (never `fetch`, CLAUDE.md rule 8) and writes them
 * through the outbox. Reuses an existing row's id for a kind instead of risking a
 * second row under `UNIQUE(kind)` — same pattern as `useToggleHabitLog`
 * (src/features/habits/use-toggle-habit-log.ts).
 */
export function useReminderPrefs() {
  const rows = useLiveTable('reminder_prefs', toReminderPrefRow);

  const prefs = useMemo<ReminderPrefView[] | undefined>(() => {
    if (rows === undefined) return undefined;
    return REMINDER_KINDS.map((meta) => {
      const row = rows.find((candidate) => candidate.kind === meta.kind);
      return row
        ? { kind: meta.kind, label: meta.label, enabled: row.enabled, times: row.times, persisted: true }
        : { kind: meta.kind, label: meta.label, enabled: true, times: meta.defaultTimes, persisted: false };
    });
  }, [rows]);

  const write = useCallback(
    (kind: string, patch: { enabled?: boolean; times?: string[] }) => {
      const view = prefs?.find((candidate) => candidate.kind === kind);
      if (!view) return Promise.resolve('');
      return mutate({
        table: 'reminder_prefs',
        rowId: rows?.find((candidate) => candidate.kind === kind)?.id,
        op: 'upsert',
        payload: {
          kind,
          enabled: patch.enabled ?? view.enabled,
          times: patch.times ?? view.times,
        },
      });
    },
    [prefs, rows],
  );

  const toggle = useCallback(
    (kind: string) => {
      const view = prefs?.find((candidate) => candidate.kind === kind);
      return write(kind, { enabled: !view?.enabled });
    },
    [prefs, write],
  );

  const addTime = useCallback(
    (kind: string, time: string) => {
      const view = prefs?.find((candidate) => candidate.kind === kind);
      return write(kind, { times: dedupeSorted([...(view?.times ?? []), time]) });
    },
    [prefs, write],
  );

  const removeTime = useCallback(
    (kind: string, time: string) => {
      const view = prefs?.find((candidate) => candidate.kind === kind);
      return write(kind, { times: (view?.times ?? []).filter((candidate) => candidate !== time) });
    },
    [prefs, write],
  );

  const setTimeAt = useCallback(
    (kind: string, index: number, time: string) => {
      const view = prefs?.find((candidate) => candidate.kind === kind);
      const next = [...(view?.times ?? [])];
      next[index] = time;
      return write(kind, { times: dedupeSorted(next) });
    },
    [prefs, write],
  );

  return { prefs, toggle, addTime, removeTime, setTimeAt };
}
