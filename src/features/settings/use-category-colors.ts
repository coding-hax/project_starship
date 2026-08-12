'use client';

import { useCallback, useMemo } from 'react';
import { EVENT_CATEGORIES } from '@/features/events/use-events';
import { mutate } from '@/local/outbox';
import { useLiveTable } from '@/local/use-live-table';
import { SWATCH_PALETTE } from '@/ui/swatch-palette';

interface CategoryColorRow {
  id: string;
  category: string;
  color: string;
}

/**
 * Merged view for one calendar category — the stored override if a row exists,
 * `color: null` otherwise (issue #660 AC5: no row means the `--cat-*` default
 * from tokens.css, never a fallback baked in here). `persisted` mirrors
 * `ReminderPrefView.persisted` (use-reminder-prefs.ts) so nothing needs to know
 * whether a row exists to render correctly.
 */
export interface CategoryColorView {
  category: string;
  label: string;
  color: string | null;
  persisted: boolean;
}

function toCategoryColorRow(id: string, data: Record<string, unknown>): CategoryColorRow {
  return {
    id,
    category: typeof data.category === 'string' ? data.category : '',
    color: typeof data.color === 'string' ? data.color : '',
  };
}

const SWATCH_TOKENS = new Set(SWATCH_PALETTE.map((swatch) => swatch.token));

/**
 * Reads category colours (never `fetch`, CLAUDE.md rule 8) and writes them
 * through the outbox. Reuses an existing row's id for a category instead of
 * risking a second row under `UNIQUE(category)` — same pattern as
 * `useReminderPrefs`/`useToggleHabitLog`.
 */
export function useCategoryColors() {
  const rows = useLiveTable('category_colors', toCategoryColorRow);

  const colors = useMemo<CategoryColorView[] | undefined>(() => {
    if (rows === undefined) return undefined;
    return EVENT_CATEGORIES.map((meta) => {
      const row = rows.find((candidate) => candidate.category === meta.value);
      const color = row && SWATCH_TOKENS.has(row.color) ? row.color : null;
      return { category: meta.value, label: meta.label, color, persisted: color !== null };
    });
  }, [rows]);

  /** Every category with >=2 uses of the same token — drives AC8's visible marker. */
  const sharedTokens = useMemo(() => {
    const counts = new Map<string, number>();
    for (const view of colors ?? []) {
      if (!view.color) continue;
      counts.set(view.color, (counts.get(view.color) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count >= 2).map(([token]) => token));
  }, [colors]);

  const setColor = useCallback(
    (category: string, token: string) => {
      if (!SWATCH_TOKENS.has(token)) return Promise.resolve('');
      const rowId = rows?.find((candidate) => candidate.category === category)?.id;
      return mutate({
        table: 'category_colors',
        rowId,
        op: 'upsert',
        payload: { category, color: token },
      });
    },
    [rows],
  );

  const resetColor = useCallback(
    (category: string) => {
      const rowId = rows?.find((candidate) => candidate.category === category)?.id;
      if (!rowId) return Promise.resolve('');
      return mutate({ table: 'category_colors', rowId, op: 'delete' });
    },
    [rows],
  );

  return { colors, sharedTokens, setColor, resetColor };
}
