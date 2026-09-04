'use client';

import './journal-search.css';
import { toggleFilterChip, useJournalSearchState, type JournalFilterChip } from './journal-search-state';

const RANGE_FORMATTER = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'numeric' });

function formatRangeValue(from: string, to: string): string {
  const fromLabel = from ? RANGE_FORMATTER.format(new Date(`${from}T00:00:00`)) : '';
  const toLabel = to ? RANGE_FORMATTER.format(new Date(`${to}T00:00:00`)) : '';
  if (from && to) return `${fromLabel}–${toLabel}`;
  return from ? `ab ${fromLabel}` : `bis ${toLabel}`;
}

function FilterChip({
  kind,
  label,
  value,
  expanded,
}: {
  kind: JournalFilterChip;
  label: string;
  value?: string;
  expanded: boolean;
}) {
  const isSet = value !== undefined;
  return (
    <button
      type="button"
      className={`page-head__chip journal-search-chips__${kind} ${
        isSet ? 'page-head__chip--set' : 'page-head__chip--outline'
      }`}
      aria-expanded={expanded}
      aria-controls="journal-search-filter-panel"
      onClick={() => toggleFilterChip(kind)}
    >
      {isSet ? `${label}: ${value}` : label}
    </button>
  );
}

/**
 * The three filter chips (issue #1051 AK2/AK3): live in PageHead's `extra`
 * slot while search mode is open. Each chip only toggles which filter's
 * controls show below (`journal-search-state.ts`'s `openChip`) — the actual
 * mood scale / tag select / date inputs stay in journal-search.tsx, next to
 * the results they filter, not up here.
 */
export function JournalSearchChips() {
  const { mood, tag, from, to, openChip } = useJournalSearchState();

  return (
    <div className="page-head__chips">
      <FilterChip
        kind="mood"
        label="Stimmung"
        value={mood !== null ? String(mood) : undefined}
        expanded={openChip === 'mood'}
      />
      <FilterChip kind="tag" label="Tag" value={tag ?? undefined} expanded={openChip === 'tag'} />
      <FilterChip
        kind="range"
        label="Zeitraum"
        value={from || to ? formatRangeValue(from, to) : undefined}
        expanded={openChip === 'range'}
      />
    </div>
  );
}
