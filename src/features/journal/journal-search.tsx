'use client';

import { useState } from 'react';
import './journal-search.css';
import { searchJournalEntries } from './search';
import { useJournalSearchEntries } from './use-journal-search-entries';

const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Local calendar day from a `YYYY-MM-DD` key, not UTC (same reasoning as
 * journal-editor.tsx's `todayKey`). */
function formatEntryDate(entryDate: string): string {
  const [year, month, day] = entryDate.split('-').map(Number);
  return DATE_FORMATTER.format(new Date(year, month - 1, day));
}

/**
 * Suchfeld im Journal (issue #341, S4 von #302): sucht rein im Speicher über
 * den Sitzungs-Cache aus use-journal-search-entries.ts (AC1, AC2, AC4) — kein
 * eigener Ladezustand (AC4/Produktprinzip 1), solange der Cache noch aufbaut
 * bleibt die Suche einfach still.
 */
export function JournalSearch({ onSelect }: { onSelect: (entryDate: string) => void }) {
  const entries = useJournalSearchEntries();
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const results = entries && trimmed ? searchJournalEntries(entries, query) : [];

  function handleSelect(entryDate: string) {
    setQuery('');
    onSelect(entryDate);
  }

  return (
    <div className="journal-search">
      <input
        type="search"
        className="journal-search__input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Journal durchsuchen …"
        aria-label="Journal durchsuchen"
      />
      {trimmed && entries !== undefined && results.length === 0 && (
        <p className="journal-search__empty">Keine Treffer.</p>
      )}
      {results.length > 0 && (
        <ul className="journal-search__results">
          {results.map((entry) => (
            <li key={entry.entryDate}>
              <button
                type="button"
                className="journal-search__result"
                onClick={() => handleSelect(entry.entryDate)}
              >
                <span className="journal-search__result-date">{formatEntryDate(entry.entryDate)}</span>
                {entry.text && (
                  <span className="journal-search__result-snippet">{entry.text}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
