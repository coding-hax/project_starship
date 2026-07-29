/** One entry's already-decrypted searchable fields (issue #341, extended in
 * #376 to a per-entry rather than per-day shape) — never persisted, only ever
 * held in memory by the session cache that builds this. */
export interface JournalSearchEntry {
  id: string;
  entryDate: string;
  createdAt: string;
  text: string;
  tags: string[];
}

/**
 * Pure, in-memory search over already-decrypted entries (AC1) — owner decision
 * "3a" in #301: decrypt on load, scan in memory, no on-disk index. Case-insensitive
 * substring match against text and tags; a blank query has nothing to search for
 * and returns no results. Since issue #376 a day can carry several entries — most
 * recent entry first, not most recent day (AC6).
 */
export function searchJournalEntries(
  entries: JournalSearchEntry[],
  query: string,
): JournalSearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  return entries
    .filter(
      (entry) =>
        entry.text.toLowerCase().includes(needle) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(needle)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
