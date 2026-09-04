'use client';

import { Fragment, useMemo, useState } from 'react';
import { MoodScale } from '@/ui/mood-scale';
import { IconReset } from '@/ui/icons';
import './journal-search.css';
import { searchJournalEntries, splitHighlight, type JournalSearchEntry } from './search';
import { useJournalSearchMode } from './journal-view-mode';

/** Wochentag kurz, Tag numerisch, Monat lang — derselbe Formatter, den die
 * Tagesüberschriften des Stroms (journal-editor.tsx) und die Kopfzeile
 * (journal-header-date.tsx) benutzen, damit ein Treffer wie der Eintrag liest,
 * auf den er zeigt (issue #700 AK6). */
const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
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

/** A result is one entry, not a day (issue #376 AC6) — its full date and time
 * together tell two same-day results apart. Since issue #700 AK6 this is the
 * spelled-out date („Sa. 8. August · 10:12"): Intl renders the short weekday
 * with a trailing comma („Sa.,"), and that comma stays — it matches the day
 * headers in the stream rather than being stripped by hand. */
function formatEntryDateTime(entryDate: string, createdAt: string): string {
  return `${formatEntryDate(entryDate)} · ${TIME_FORMATTER.format(new Date(createdAt))}`;
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
 * und „Abbrechen" verlässt ihn wieder.
 *
 * Seit issue #847 (AK1/AK2) läuft die Suche, solange der Suchmodus offen ist,
 * immer mit `showAllWhenEmpty: true` — ein leeres Feld zeigt darum sofort alle
 * Einträge, statt auf Enter oder das offene Filter-Menü zu warten (der frühere
 * `showAll`-State und der Enter-Sonderweg aus issue #456 sind damit
 * überflüssig geworden).
 *
 * `entries` kommt seit issue #1049 (AK6) als Prop von `journal-editor.tsx`
 * hinein statt aus einem eigenen `useJournalSearchEntries()`-Aufruf hier: der
 * Hook läuft dort einmal, unabhängig vom Suchmodus (damit das Öffnen ohne
 * Ladepause Treffer zeigt), und dieselben Einträge speist „An diesem Tag" —
 * ein zweiter Hook-Aufruf hier würde den Sitzungs-Cache ein zweites Mal
 * entschlüsseln.
 */
export function JournalSearch({
  entries,
  onSelect,
}: {
  entries: JournalSearchEntry[] | undefined;
  onSelect: (entryDate: string) => void;
}) {
  const { active, close } = useJournalSearchMode();
  const [query, setQuery] = useState('');
  const [mood, setMood] = useState<number | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  const tagOptions = useMemo(() => {
    const all = new Set<string>();
    for (const entry of entries ?? []) {
      for (const t of entry.tags) all.add(t);
    }
    return [...all].sort();
  }, [entries]);

  const results = entries
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
    : [];

  function resetFilters() {
    setMood(null);
    setTag(null);
    setFrom('');
    setTo('');
  }

  function clearSearchState() {
    setQuery('');
    resetFilters();
    // issue #456/#847: showFilters hält den Suchmodus zwar nicht mehr offen
    // (der bleibt ohnehin immer aktiv), aber das Filter-Menü selbst soll beim
    // erneuten Öffnen wieder eingeklappt starten (AK4).
    setShowFilters(false);
  }

  /** „Abbrechen" (issue #700 AK6): verlässt den Suchmodus und stellt Editor +
   * FAB wieder her; die Filterwerte werden zurückgesetzt, damit ein späteres
   * erneutes Öffnen leer beginnt. */
  function handleCancel() {
    clearSearchState();
    close();
  }

  function handleSelect(entryDate: string) {
    clearSearchState();
    close();
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

  // Alle Hooks laufen oben — erst danach entscheidet der Suchmodus, ob
  // überhaupt etwas gerendert wird (AK5).
  if (!active) return null;

  return (
    <div className="journal-search">
      <div className="journal-search__bar">
        <input
          type="search"
          className="journal-search__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Journal durchsuchen …"
          aria-label="Journal durchsuchen"
          autoFocus
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
        <button type="button" className="journal-search__cancel" onClick={handleCancel}>
          Abbrechen
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
            <button
              type="button"
              className="journal-search__reset"
              aria-label="Zurücksetzen"
              onClick={resetFilters}
            >
              <IconReset />
            </button>
          </div>
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
        <ul className="journal-search__results">
          {results.map((entry) => (
            <JournalSearchResult
              key={entry.id}
              entry={entry}
              query={query}
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
  query,
  expanded,
  onToggleExpanded,
  onSelect,
}: {
  entry: JournalSearchEntry;
  query: string;
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
