'use client';

import { IconClose, IconSearch } from '@/ui/icons';
import './journal-search.css';
import { resetJournalSearch, setSearchQuery, useJournalSearchState } from './journal-search-state';
import { closeJournalSearch } from './journal-view-mode';

/**
 * The search pill that replaces the eyebrow row's date+lupe while search mode
 * is open (issue #1051 AK1): lupe inside on the left, a clear-× inside on the
 * right once there is something to clear, „Abbrechen" beside the pill. Kept
 * as its own component (rather than inline in journal-page-head.tsx) so
 * journal-search.css stays the one file owning every search-related class.
 */
export function JournalSearchBar() {
  const { query } = useJournalSearchState();

  function handleCancel() {
    resetJournalSearch();
    closeJournalSearch();
  }

  return (
    <div className="journal-search-bar">
      <div className="journal-search-bar__pill">
        <IconSearch className="journal-search-bar__icon" />
        <input
          type="text"
          className="journal-search__input"
          value={query}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Journal durchsuchen …"
          aria-label="Journal durchsuchen"
          autoFocus
        />
        {query && (
          <button
            type="button"
            className="journal-search-bar__clear"
            aria-label="Suche leeren"
            onClick={() => setSearchQuery('')}
          >
            <IconClose />
          </button>
        )}
      </div>
      <button type="button" className="journal-search__cancel" onClick={handleCancel}>
        Abbrechen
      </button>
    </div>
  );
}
