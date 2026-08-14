import { describe, expect, it } from 'vitest';
import {
  searchJournalEntries,
  splitHighlight,
  type JournalFilters,
  type JournalSearchEntry,
} from './search';

function entry(
  id: string,
  createdAt: string,
  text: string,
  tags: string[] = [],
  entryDate = createdAt.slice(0, 10),
  mood?: string,
): JournalSearchEntry {
  return { id, entryDate, createdAt, text, tags, mood };
}

/** Most existing tests only care about free-text query behaviour — this keeps
 * them reading like calls against the pre-#415 `(entries, query)` signature. */
function searchByQuery(entries: JournalSearchEntry[], query: string): JournalSearchEntry[] {
  return searchJournalEntries(entries, { query });
}

describe('searchJournalEntries', () => {
  it('findet Treffer im Text, case-insensitiv', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Ein RUHIGER Tag'),
      entry('b', '2026-07-02T09:00:00.000Z', 'Nichts Besonderes'),
    ];
    expect(searchByQuery(entries, 'ruhiger')).toEqual([entries[0]]);
  });

  it('findet Treffer in Tags, case-insensitiv', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Text', ['Sport']),
      entry('b', '2026-07-02T09:00:00.000Z', 'Text', ['Arbeit']),
    ];
    expect(searchByQuery(entries, 'sport')).toEqual([entries[0]]);
  });

  it('liefert die neuesten Einträge zuerst, auch mehrere am selben Tag (issue #376)', () => {
    const entries = [
      entry('a', '2026-07-01T08:00:00.000Z', 'Lauf am Fluss'),
      entry('b', '2026-07-01T18:00:00.000Z', 'Lauf am Abend'),
      entry('c', '2026-07-02T08:00:00.000Z', 'Lauf im Wald'),
    ];
    expect(searchByQuery(entries, 'lauf').map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('leere oder reine Whitespace-Anfrage liefert keine Treffer', () => {
    const entries = [entry('a', '2026-07-01T09:00:00.000Z', 'Irgendwas')];
    expect(searchByQuery(entries, '')).toEqual([]);
    expect(searchByQuery(entries, '   ')).toEqual([]);
  });

  it('kein Treffer liefert ein leeres Array', () => {
    const entries = [entry('a', '2026-07-01T09:00:00.000Z', 'Irgendwas')];
    expect(searchByQuery(entries, 'nichtvorhanden')).toEqual([]);
  });

  it('bleibt mit 2000 Einträgen deutlich unter 100ms (AC4)', () => {
    const entries: JournalSearchEntry[] = Array.from({ length: 2000 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      const year = 20 + Math.floor(i / 365);
      return entry(
        `id-${i}`,
        `20${year}-${month}-${day}T09:00:00.000Z`,
        `Eintrag Nummer ${i} über den Tag`,
        [`tag-${i % 10}`],
      );
    });

    const start = performance.now();
    const results = searchByQuery(entries, 'tag-3');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });

  it('Mood-Filter (AC-F1): nur Einträge mit der gewählten Stimmung', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Text', [], undefined, '3'),
      entry('b', '2026-07-02T09:00:00.000Z', 'Text', [], undefined, '7'),
      entry('c', '2026-07-03T09:00:00.000Z', 'Text', [], undefined, '7'),
    ];
    const filters: JournalFilters = { query: '', mood: '7' };
    expect(searchJournalEntries(entries, filters).map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('Tag-Filter (AC-F2): nur Einträge mit exakt diesem Tag', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Text', ['sport']),
      entry('b', '2026-07-02T09:00:00.000Z', 'Text', ['büro']),
    ];
    const filters: JournalFilters = { query: '', tag: 'sport' };
    expect(searchJournalEntries(entries, filters)).toEqual([entries[0]]);
  });

  it('Datumsbereich (AC-F3): von/bis einzeln und kombiniert, inklusiv', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Text', [], '2026-07-01'),
      entry('b', '2026-07-05T09:00:00.000Z', 'Text', [], '2026-07-05'),
      entry('c', '2026-07-10T09:00:00.000Z', 'Text', [], '2026-07-10'),
    ];
    expect(searchJournalEntries(entries, { query: '', from: '2026-07-05' }).map((e) => e.id)).toEqual([
      'c',
      'b',
    ]);
    expect(searchJournalEntries(entries, { query: '', to: '2026-07-05' }).map((e) => e.id)).toEqual([
      'b',
      'a',
    ]);
    expect(
      searchJournalEntries(entries, { query: '', from: '2026-07-02', to: '2026-07-09' }).map((e) => e.id),
    ).toEqual(['b']);
  });

  it('Kombination aller Filter verengt per UND (AC-F4)', () => {
    const entries = [
      entry('a', '2026-07-05T09:00:00.000Z', 'Ruhiger Lauf', ['sport'], '2026-07-05', '7'),
      entry('b', '2026-07-05T10:00:00.000Z', 'Ruhiger Lauf', ['sport'], '2026-07-05', '3'),
      entry('c', '2026-07-05T11:00:00.000Z', 'Büro-Tag', ['sport'], '2026-07-05', '7'),
    ];
    const filters: JournalFilters = { query: 'lauf', mood: '7', tag: 'sport', from: '2026-07-01', to: '2026-07-31' };
    expect(searchJournalEntries(entries, filters)).toEqual([entries[0]]);
  });

  it('kein Filter aktiv liefert ein leeres Array', () => {
    const entries = [entry('a', '2026-07-01T09:00:00.000Z', 'Irgendwas')];
    expect(searchJournalEntries(entries, { query: '' })).toEqual([]);
  });
});

describe('splitHighlight (issue #700 AK6)', () => {
  it('markiert das Suchwort case-insensitiv, sonst nichts', () => {
    expect(splitHighlight('Ein Lauf am Fluss', 'lauf')).toEqual([
      { text: 'Ein ', highlighted: false },
      { text: 'Lauf', highlighted: true },
      { text: ' am Fluss', highlighted: false },
    ]);
  });

  it('markiert jedes Vorkommen', () => {
    expect(splitHighlight('Lauf und noch ein Lauf', 'lauf')).toEqual([
      { text: 'Lauf', highlighted: true },
      { text: ' und noch ein ', highlighted: false },
      { text: 'Lauf', highlighted: true },
    ]);
  });

  it('leere oder reine Whitespace-Anfrage markiert nichts', () => {
    expect(splitHighlight('Ein Lauf', '')).toEqual([{ text: 'Ein Lauf', highlighted: false }]);
    expect(splitHighlight('Ein Lauf', '   ')).toEqual([{ text: 'Ein Lauf', highlighted: false }]);
  });

  it('kein Treffer gibt den ganzen Text als eine unmarkierte Einheit zurück', () => {
    expect(splitHighlight('Ein ruhiger Tag', 'lauf')).toEqual([
      { text: 'Ein ruhiger Tag', highlighted: false },
    ]);
  });
});
