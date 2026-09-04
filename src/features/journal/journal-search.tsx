'use client';

import { Fragment, useMemo, useState, type CSSProperties } from 'react';
import { MoodScale } from '@/ui/mood-scale';
import { IconReset } from '@/ui/icons';
import './journal-search.css';
import { searchJournalEntries, splitHighlight, type JournalSearchEntry } from './search';
import {
  resetJournalSearch,
  setMoodFilter,
  setRangeFilter,
  setTagFilter,
  useJournalSearchState,
} from './journal-search-state';
import { useJournalSearchMode } from './journal-view-mode';
import { useJournalSearchEntries } from './use-journal-search-entries';

/** Day + long month, no year — the year is the group heading's job (AK4), not
 * a repeated per-row detail (issue #1051 AK5). */
const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });

/** Deterministic character threshold (issue #415 AC-P3) rather than a CSS
 * overflow measurement — makes the cut Playwright-testable. */
const SNIPPET_CHAR_LIMIT = 140;

/** Local calendar day from a `YYYY-MM-DD` key, not UTC (same reasoning as
 * journal-editor.tsx's `todayKey`). */
function formatEntryDate(entryDate: string): string {
  const [year, month, day] = entryDate.split('-').map(Number);
  return DATE_FORMATTER.format(new Date(year, month - 1, day));
}

function yearOf(entryDate: string): number {
  return Number(entryDate.slice(0, 4));
}

/** "vor einem Jahr"/"vor N Jahren" — same wording #1049's "An diesem Tag"
 * rows use for the same concept. `null` for the current year: it has no
 * distance to state. */
function formatYearsAgo(entryYear: number, currentYear: number): string | null {
  const diff = currentYear - entryYear;
  if (diff <= 0) return null;
  return diff === 1 ? 'vor einem Jahr' : `vor ${diff} Jahren`;
}

/** A result row's top line (issue #1051 AK5): date, plus how long ago in
 * words once the entry is from an earlier year than today. */
function formatResultMeta(entryDate: string, currentYear: number): string {
  const ago = formatYearsAgo(yearOf(entryDate), currentYear);
  return ago ? `${formatEntryDate(entryDate)} · ${ago}` : formatEntryDate(entryDate);
}

interface YearGroup {
  year: number;
  entries: JournalSearchEntry[];
}

/** Newest year first (AK4); within a year, `searchJournalEntries`'s own
 * createdAt-descending order is preserved (issue #376 AC6). */
function groupByYear(entries: JournalSearchEntry[]): YearGroup[] {
  const byYear = new Map<number, JournalSearchEntry[]>();
  for (const entry of entries) {
    const year = yearOf(entry.entryDate);
    const group = byYear.get(year);
    if (group) group.push(entry);
    else byYear.set(year, [entry]);
  }
  return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, list]) => ({ year, entries: list }));
}

/**
 * Suchfeld + Filter im Journal (issue #341/#376, erweitert um Mood-/Tag-/
 * Datumsfilter und die Treffervorschau in issue #415): sucht rein im Speicher
 * über den Sitzungs-Cache aus use-journal-search-entries.ts (AC1, AC2, AC4) —
 * kein eigener Ladezustand (AC4/Produktprinzip 1), solange der Cache noch
 * aufbaut bleibt die Suche einfach still.
 *
 * Seit issue #700 (AK5/AK6) ist das Suchfeld nicht mehr dauerhaft sichtbar: es
 * erscheint erst, wenn die Lupe den Suchmodus öffnet (`useJournalSearchMode`),
 * und „Abbrechen" verlässt ihn wieder. Der Cache-Hook läuft dennoch bei jedem
 * Render (vor dem frühen `return null`), damit das Öffnen ohne Ladepause
 * Treffer zeigt.
 *
 * Seit issue #1051 lebt die eigentliche Such-/Filterleiste nicht mehr hier:
 * die Pille sitzt in der Augenbrauenzeile (journal-search-bar.tsx), die drei
 * Filter als Chips im `extra`-Slot (journal-search-chips.tsx) — beide lesen
 * denselben Modul-Store (journal-search-state.ts). Diese Komponente zeigt nur
 * noch das gerade offene Filter-Panel (höchstens eins, AK2) sowie die nach
 * Jahr gruppierten Treffer (AK4/AK5).
 */
export function JournalSearch({ onSelect }: { onSelect: (entryDate: string) => void }) {
  const { active, close } = useJournalSearchMode();
  const entries = useJournalSearchEntries();
  const { query, mood, tag, from, to, openChip } = useJournalSearchState();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tagOptions = useMemo(() => {
    const all = new Set<string>();
    for (const entry of entries ?? []) {
      for (const t of entry.tags) all.add(t);
    }
    return [...all].sort();
  }, [entries]);

  const results = useMemo(
    () =>
      entries
        ? searchJournalEntries(
            entries,
            {
              query,
              mood: mood === null ? undefined : String(mood),
              tag: tag ?? undefined,
              from: from || undefined,
              to: to || undefined,
            },
            { showAllWhenEmpty: true },
          )
        : [],
    [entries, query, mood, tag, from, to],
  );
  const groups = useMemo(() => groupByYear(results), [results]);
  // Local, not module state on purpose — no other subtree reads "what year is
  // it", so this doesn't need to live in journal-search-state.ts.
  const currentYear = new Date().getFullYear();

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

  function handleSelect(entryDate: string) {
    resetJournalSearch();
    close();
    onSelect(entryDate);
  }

  // Alle Hooks laufen oben (auch der Cache-Hook, damit er warm bleibt) — erst
  // danach entscheidet der Suchmodus, ob überhaupt etwas gerendert wird (AK5).
  if (!active) return null;

  return (
    <div className="journal-search">
      {openChip && (
        <div className="journal-search__filters" id="journal-search-filter-panel">
          {openChip === 'mood' && (
            <div className="journal-search__mood-filter">
              <MoodScale value={mood} onChange={setMoodFilter} ariaLabelForValue={(n) => `Stimmung ${n} filtern`} />
            </div>
          )}
          {openChip === 'tag' && (
            <select
              className="journal-search__tag-select"
              aria-label="Tag filtern"
              value={tag ?? ''}
              onChange={(event) => setTagFilter(event.target.value || null)}
            >
              <option value="">Alle Tags</option>
              {tagOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
          {openChip === 'range' && (
            <div className="journal-search__date-range">
              <input
                type="date"
                className="journal-search__date-input"
                aria-label="Von Datum"
                value={from}
                onChange={(event) => setRangeFilter(event.target.value, to)}
              />
              <input
                type="date"
                className="journal-search__date-input"
                aria-label="Bis Datum"
                value={to}
                onChange={(event) => setRangeFilter(from, event.target.value)}
              />
              <button
                type="button"
                className="journal-search__reset"
                aria-label="Zeitraum zurücksetzen"
                onClick={() => setRangeFilter('', '')}
              >
                <IconReset />
              </button>
            </div>
          )}
        </div>
      )}
      {/* issue #847 AK3: „Keine Treffer." beschreibt eine Eingabe/einen Filter,
          der eine bestehende Liste auf nichts verengt — ein Journal ganz ohne
          Einträge ist kein Treffer-Problem und behält den ruhigen Leerzustand
          (hier: gar keine Meldung, wie schon vor dem Öffnen des Suchmodus). */}
      {entries !== undefined && entries.length > 0 && results.length === 0 && (
        <p className="journal-search__empty">Keine Treffer.</p>
      )}
      {results.length > 0 && (
        <>
          {/* AK7: die Gesamtzahl über den Jahresgruppen, mit dem Suchwort nur,
              wenn eines eingegeben ist — ein reiner Filter-Browse (Chips ohne
              Text) hat kein „für …" zu nennen. */}
          <p className="journal-search__total">
            {query.trim() ? `${results.length} Treffer für „${query.trim()}"` : `${results.length} Treffer`}
          </p>
          <div className="journal-search__groups">
            {groups.map((group) => (
              <section key={group.year} className="journal-search__year-group">
                <h2 className="journal-search__year-heading">
                  {group.year} · {group.entries.length} Treffer
                </h2>
                <ul className="journal-search__results">
                  {group.entries.map((entry) => (
                    <JournalSearchResult
                      key={entry.id}
                      entry={entry}
                      query={query}
                      currentYear={currentYear}
                      expanded={expanded.has(entry.id)}
                      onToggleExpanded={() => toggleExpanded(entry.id)}
                      onSelect={() => handleSelect(entry.entryDate)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function JournalSearchResult({
  entry,
  query,
  currentYear,
  expanded,
  onToggleExpanded,
  onSelect,
}: {
  entry: JournalSearchEntry;
  query: string;
  currentYear: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: () => void;
}) {
  const isLong = entry.text.length > SNIPPET_CHAR_LIMIT;
  const snippet = expanded || !isLong ? entry.text : `${entry.text.slice(0, SNIPPET_CHAR_LIMIT)}…`;

  return (
    <li>
      <button type="button" className="journal-search__result" onClick={onSelect}>
        <div className="journal-search__result-main">
          <span className="journal-search__result-date">{formatResultMeta(entry.entryDate, currentYear)}</span>
          {entry.text && (
            <span className="journal-search__result-snippet">
              {/* Suchwort hervorheben (issue #700 AK6): über den sichtbaren, ggf.
                  gekürzten Snippet, nicht den ganzen Eintragstext. */}
              {splitHighlight(snippet, query).map((segment, index) =>
                segment.highlighted ? (
                  <mark key={index} className="journal-search__hl">
                    {segment.text}
                  </mark>
                ) : (
                  <Fragment key={index}>{segment.text}</Fragment>
                ),
              )}
            </span>
          )}
        </div>
        {entry.mood && (
          <span
            className="journal-search__result-mood"
            style={{ '--mood': entry.mood } as CSSProperties}
            aria-label={`Stimmung ${entry.mood}/10`}
          >
            {entry.mood}
          </span>
        )}
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
