import { describe, expect, it } from 'vitest';
import { formatYearCount, formatYearsAgo, sameDayEntries } from './same-day';
import type { JournalSearchEntry } from './search';

function entry(
  id: string,
  entryDate: string,
  createdAt: string,
  text: string,
  mood?: string,
): JournalSearchEntry {
  return { id, entryDate, createdAt, text, tags: [], mood };
}

describe('sameDayEntries', () => {
  it('listet jeden anderen Jahrgang mit Eintrag am selben Monat+Tag, neueste zuerst (AK1)', () => {
    const entries = [
      entry('a', '2019-08-15', '2019-08-15T09:00:00.000Z', 'Vor sieben Jahren'),
      entry('b', '2009-08-15', '2009-08-15T09:00:00.000Z', 'Vor 17 Jahren'),
      entry('c', '2025-08-15', '2025-08-15T09:00:00.000Z', 'Vor einem Jahr'),
    ];
    const years = sameDayEntries(entries, '2026-08-15');
    expect(years.map((y) => y.year)).toEqual([2025, 2019, 2009]);
    expect(years.map((y) => y.yearsAgo)).toEqual([1, 7, 17]);
  });

  it('lässt Jahre ohne Eintrag an diesem Tag aus (AK2)', () => {
    const entries = [entry('a', '2026-01-03', '2026-01-03T09:00:00.000Z', 'Anderer Tag')];
    expect(sameDayEntries(entries, '2026-08-15')).toEqual([]);
  });

  it('wählt je Jahr den zuerst angelegten Eintrag (gleiche Regel wie #1048)', () => {
    const entries = [
      entry('later', '2020-08-15', '2020-08-15T18:00:00.000Z', 'Abends geschrieben'),
      entry('first', '2020-08-15', '2020-08-15T07:00:00.000Z', 'Morgens geschrieben'),
    ];
    const years = sameDayEntries(entries, '2026-08-15');
    expect(years).toHaveLength(1);
    expect(years[0].entry.id).toBe('first');
  });

  it('ignoriert das aktuelle Jahr selbst', () => {
    const entries = [entry('a', '2026-08-15', '2026-08-15T09:00:00.000Z', 'Heute')];
    expect(sameDayEntries(entries, '2026-08-15')).toEqual([]);
  });

  it('zeigt am 29. Februar nur andere Schalttage, kein Ausweichen auf den 28. (AK7)', () => {
    const entries = [
      entry('leap', '2020-02-29', '2020-02-29T09:00:00.000Z', 'Schalttag'),
      entry('feb28', '2025-02-28', '2025-02-28T09:00:00.000Z', 'Kein Schaltjahr'),
    ];
    const years = sameDayEntries(entries, '2024-02-29');
    expect(years.map((y) => y.year)).toEqual([2020]);
  });

  it('bleibt ohne obere Grenze für den Abstand', () => {
    const entries = [entry('a', '1990-08-15', '1990-08-15T09:00:00.000Z', 'Sehr alt')];
    const years = sameDayEntries(entries, '2026-08-15');
    expect(years).toEqual([{ year: 1990, yearsAgo: 36, entry: entries[0] }]);
  });
});

describe('formatYearsAgo', () => {
  it('formuliert ein Jahr im Dativ', () => {
    expect(formatYearsAgo(1)).toBe('vor einem Jahr');
  });

  it('schreibt einstellige Abstände als Wort', () => {
    expect(formatYearsAgo(7)).toBe('vor sieben Jahren');
  });

  it('schreibt zweistellige Abstände als Ziffer', () => {
    expect(formatYearsAgo(17)).toBe('vor 17 Jahren');
  });
});

describe('formatYearCount', () => {
  it('formuliert einen Treffer in Einzahl', () => {
    expect(formatYearCount(1)).toBe('ein Jahr');
  });

  it('formuliert mehrere Treffer in Mehrzahl mit Ziffer', () => {
    expect(formatYearCount(4)).toBe('4 Jahre');
  });
});
