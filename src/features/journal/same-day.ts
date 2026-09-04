import type { JournalSearchEntry } from './search';

export interface SameDayYear {
  year: number;
  yearsAgo: number;
  entry: JournalSearchEntry;
}

const SMALL_NUMBER_WORDS: Record<number, string> = {
  2: 'zwei',
  3: 'drei',
  4: 'vier',
  5: 'fünf',
  6: 'sechs',
  7: 'sieben',
  8: 'acht',
  9: 'neun',
};

/** "vor einem Jahr" / "vor sieben Jahren" / "vor 17 Jahren" (AK3, #1049): 1 is
 * the dative special case, 2–9 spelled out, 10+ as digits — same convention as
 * running German text. */
export function formatYearsAgo(yearsAgo: number): string {
  if (yearsAgo === 1) return 'vor einem Jahr';
  const word = SMALL_NUMBER_WORDS[yearsAgo] ?? String(yearsAgo);
  return `vor ${word} Jahren`;
}

/** "4 Jahre" / "ein Jahr" (AK4, #1049) — the section header's count. */
export function formatYearCount(count: number): string {
  return count === 1 ? 'ein Jahr' : `${count} Jahre`;
}

/**
 * Every OTHER year that has at least one entry on the same month+day as
 * `todayKey` (`YYYY-MM-DD`, AK1/AK2, #1049) — newest year first, no upper
 * bound. Picks the first-created entry per year (`createdAt` ascending), same
 * rule as the day's own line (#1048). A plain string comparison of the
 * `MM-DD` slice both selects same-day entries and, as a side effect, keeps
 * Feb 29 matching only other Feb 29s (AK7) — a `YYYY-MM-DD` entryDate is only
 * ever `02-29` when it was actually written on a leap day, so there is no
 * "closest day" fallback to guard against.
 */
export function sameDayEntries(entries: JournalSearchEntry[], todayKey: string): SameDayYear[] {
  const todayYear = todayKey.slice(0, 4);
  const monthDay = todayKey.slice(5);

  const byYear = new Map<string, JournalSearchEntry[]>();
  for (const entry of entries) {
    const year = entry.entryDate.slice(0, 4);
    if (year === todayYear) continue;
    if (entry.entryDate.slice(5) !== monthDay) continue;
    const bucket = byYear.get(year);
    if (bucket) {
      bucket.push(entry);
    } else {
      byYear.set(year, [entry]);
    }
  }

  const currentYear = Number(todayYear);
  return [...byYear.entries()]
    .map(([year, yearEntries]) => {
      const first = [...yearEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const numericYear = Number(year);
      return { year: numericYear, yearsAgo: currentYear - numericYear, entry: first };
    })
    .sort((a, b) => b.year - a.year);
}
