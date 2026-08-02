'use client';

import { useEffect, useMemo, useState } from 'react';
import { MoodScale } from '@/ui/mood-scale';
import './journal-search.css';
import { searchJournalEntries, type JournalSearchEntry } from './search';
import { useJournalSearchEntries } from './use-journal-search-entries';

const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

/** Deterministic character threshold (issue #415 AC-P3) rather than a CSS
 * overflow measurement — makes the cut Playwright-testable. */
const SNIPPET_CHAR_LIMIT = 140;

/** Local calendar day from a `YYYY-MM-DD` key, not UTC (same reasoning as
 * journal-editor.tsx's `todayKey`). */
function formatEntryDate(entryDate: string): string {
  const [year, month, day] = entryDate.split('-').map(Number);
  return DATE_FORMATTER.format(new Date(year, month - 1, day));
}

/** A result is one entry, not a day (issue #376 AC6) — date and time together
 * are what tells two same-day results apart. */
function formatEntryDateTime(entryDate: string, createdAt: string): string {
  return `${formatEntryDate(entryDate)}, ${TIME_FORMATTER.format(new Date(createdAt))}`;
}

/**
 * Suchfeld + Filter im Journal (issue #341/#376, erweitert um Mood-/Tag-/
 * Datumsfilter und die Treffervorschau in issue #415): sucht rein im Speicher
 * über den Sitzungs-Cache aus use-journal-search-entries.ts (AC1, AC2, AC4) —
 * kein eigener Ladezustand (AC4/Produktprinzip 1), solange der Cache noch
 * aufbaut bleibt die Suche einfach still.
 */
export function JournalSearch({
  onSelect,
  onActiveChange,
}: {
  onSelect: (entryDate: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const entries = useJournalSearchEntries();
  const [query, setQuery] = useState('');
  const [mood, setMood] = useState<number | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const trimmed = query.trim();
  const hasFilterValue = mood !== null || tag !== null || Boolean(from) || Boolean(to);
  // issue #456: das Öffnen des Filter-Menüs und ein Enter im leeren Suchfeld
  // zeigen sofort alle Einträge, statt eines leeren Ergebnisses — der Editor
  // weicht in beiden Fällen genauso wie bei einem echten Treffer.
  const isActive = Boolean(trimmed) || hasFilterValue || showFilters || showAll;

  const tagOptions = useMemo(() => {
    const all = new Set<string>();
    for (const entry of entries ?? []) {
      for (const t of entry.tags) all.add(t);
    }
    return [...all].sort();
  }, [entries]);

  const results =
    entries && isActive
      ? searchJournalEntries(
          entries,
          {
            query,
            mood: mood === null ? undefined : String(mood),
            tag: tag ?? undefined,
            from: from || undefined,
            to: to || undefined,
          },
          { showAllWhenEmpty: showFilters || showAll },
        )
      : [];

  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  function resetFilters() {
    setMood(null);
    setTag(null);
    setFrom('');
    setTo('');
  }

  function handleSelect(entryDate: string) {
    setQuery('');
    resetFilters();
    setShowAll(false);
    // issue #456: showFilters allein hält isActive sonst weiter offen, selbst
    // nach dem Reset der Filterwerte — ein Treffer wählen muss die Suche
    // vollständig verlassen (AC-P4), nicht nur die Filterwerte leeren.
    setShowFilters(false);
    onSelect(entryDate);
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="journal-search">
      <div className="journal-search__bar">
        <input
          type="search"
          className="journal-search__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              setShowAll(true);
            }
          }}
          placeholder="Journal durchsuchen …"
          aria-label="Journal durchsuchen"
        />
        <button
          type="button"
          className="journal-search__filter-toggle"
          aria-expanded={showFilters}
          aria-controls="journal-search-filters"
          onClick={() => setShowFilters((current) => !current)}
        >
          Filter
        </button>
      </div>
      {showFilters && (
        <div className="journal-search__filters" id="journal-search-filters">
          <div className="journal-search__mood-filter">
            <MoodScale value={mood} onChange={setMood} ariaLabelForValue={(n) => `Stimmung ${n} filtern`} />
          </div>
          {tagOptions.length > 0 && (
            <select
              className="journal-search__tag-select"
              aria-label="Tag filtern"
              value={tag ?? ''}
              onChange={(event) => setTag(event.target.value || null)}
            >
              <option value="">Alle Tags</option>
              {tagOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
          <div className="journal-search__date-range">
            <input
              type="date"
              className="journal-search__date-input"
              aria-label="Von Datum"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <input
              type="date"
              className="journal-search__date-input"
              aria-label="Bis Datum"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <button type="button" className="journal-search__reset" onClick={resetFilters}>
            Zurücksetzen
          </button>
        </div>
      )}
      {isActive && entries !== undefined && results.length === 0 && (
        <p className="journal-search__empty">Keine Treffer.</p>
      )}
      {results.length > 0 && (
        <ul className="journal-search__results">
          {results.map((entry) => (
            <JournalSearchResult
              key={entry.id}
              entry={entry}
              expanded={expanded.has(entry.id)}
              onToggleExpanded={() => toggleExpanded(entry.id)}
              onSelect={() => handleSelect(entry.entryDate)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function JournalSearchResult({
  entry,
  expanded,
  onToggleExpanded,
  onSelect,
}: {
  entry: JournalSearchEntry;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: () => void;
}) {
  const isLong = entry.text.length > SNIPPET_CHAR_LIMIT;
  const snippet = expanded || !isLong ? entry.text : `${entry.text.slice(0, SNIPPET_CHAR_LIMIT)}…`;

  return (
    <li>
      <button type="button" className="journal-search__result" onClick={onSelect}>
        <span className="journal-search__result-date">
          {formatEntryDateTime(entry.entryDate, entry.createdAt)}
          {entry.mood && <span className="journal-search__result-mood"> · Stimmung {entry.mood}/10</span>}
        </span>
        {entry.text && <span className="journal-search__result-snippet">{snippet}</span>}
      </button>
      {isLong && (
        <button
          type="button"
          className="journal-search__result-expand"
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpanded();
          }}
        >
          {expanded ? 'Weniger anzeigen' : 'Vollständigen Text anzeigen'}
        </button>
      )}
    </li>
  );
}
