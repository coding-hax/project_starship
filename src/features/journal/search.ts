/** One entry's already-decrypted searchable fields (issue #341, extended in
 * #376 to a per-entry rather than per-day shape, and in #415 with `mood` for
 * the mood filter/preview) — never persisted, only ever held in memory by the
 * session cache that builds this. */
export interface JournalSearchEntry {
  id: string;
  entryDate: string;
  createdAt: string;
  text: string;
  tags: string[];
  mood?: string;
}

/** AND-combined filter set (issue #415): free text stays a substring match
 * over text+tags (unchanged since #341), everything else narrows further —
 * only fields that are set participate. */
export interface JournalFilters {
  query: string;
  mood?: string;
  tag?: string;
  from?: string;
  to?: string;
}

/**
 * Pure, in-memory search over already-decrypted entries (AC1) — owner decision
 * "3a" in #301: decrypt on load, scan in memory, no on-disk index. Free text is
 * a case-insensitive substring match against text and tags; every other filter
 * (mood, tag, date range) narrows the result further (AND, issue #415 AC-F4).
 * No filter set at all has nothing to search for and returns no results —
 * unless `showAllWhenEmpty` (issue #456: opening the filter panel or
 * submitting an empty search shows every entry instead of a blank list).
 * `entryDate` is `YYYY-MM-DD`, same format `input[type=date]` produces, so the
 * date range is a plain lexicographic string comparison — no `Date`/timezone
 * involved. Since issue #376 a day can carry several entries — most recent
 * entry first, not most recent day (AC6).
 */
export function searchJournalEntries(
  entries: JournalSearchEntry[],
  filters: JournalFilters,
  options: { showAllWhenEmpty?: boolean } = {},
): JournalSearchEntry[] {
  const needle = filters.query.trim().toLowerCase();
  const isActive = Boolean(needle) || Boolean(filters.mood) || Boolean(filters.tag) || Boolean(filters.from) || Boolean(filters.to);
  if (!isActive && !options.showAllWhenEmpty) return [];

  return entries
    .filter((entry) => {
      if (
        needle &&
        !entry.text.toLowerCase().includes(needle) &&
        !entry.tags.some((tag) => tag.toLowerCase().includes(needle))
      ) {
        return false;
      }
      if (filters.mood && entry.mood !== filters.mood) return false;
      if (filters.tag && !entry.tags.includes(filters.tag)) return false;
      if (filters.from && entry.entryDate < filters.from) return false;
      if (filters.to && entry.entryDate > filters.to) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
