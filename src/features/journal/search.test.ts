import { describe, expect, it } from 'vitest';
import { searchJournalEntries, type JournalSearchEntry } from './search';

function entry(
  id: string,
  createdAt: string,
  text: string,
  tags: string[] = [],
  entryDate = createdAt.slice(0, 10),
): JournalSearchEntry {
  return { id, entryDate, createdAt, text, tags };
}

describe('searchJournalEntries', () => {
  it('findet Treffer im Text, case-insensitiv', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Ein RUHIGER Tag'),
      entry('b', '2026-07-02T09:00:00.000Z', 'Nichts Besonderes'),
    ];
    expect(searchJournalEntries(entries, 'ruhiger')).toEqual([entries[0]]);
  });

  it('findet Treffer in Tags, case-insensitiv', () => {
    const entries = [
      entry('a', '2026-07-01T09:00:00.000Z', 'Text', ['Sport']),
      entry('b', '2026-07-02T09:00:00.000Z', 'Text', ['Arbeit']),
    ];
    expect(searchJournalEntries(entries, 'sport')).toEqual([entries[0]]);
  });

  it('liefert die neuesten Einträge zuerst, auch mehrere am selben Tag (issue #376)', () => {
    const entries = [
      entry('a', '2026-07-01T08:00:00.000Z', 'Lauf am Fluss'),
      entry('b', '2026-07-01T18:00:00.000Z', 'Lauf am Abend'),
      entry('c', '2026-07-02T08:00:00.000Z', 'Lauf im Wald'),
    ];
    expect(searchJournalEntries(entries, 'lauf').map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('leere oder reine Whitespace-Anfrage liefert keine Treffer', () => {
    const entries = [entry('a', '2026-07-01T09:00:00.000Z', 'Irgendwas')];
    expect(searchJournalEntries(entries, '')).toEqual([]);
    expect(searchJournalEntries(entries, '   ')).toEqual([]);
  });

  it('kein Treffer liefert ein leeres Array', () => {
    const entries = [entry('a', '2026-07-01T09:00:00.000Z', 'Irgendwas')];
    expect(searchJournalEntries(entries, 'nichtvorhanden')).toEqual([]);
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
    const results = searchJournalEntries(entries, 'tag-3');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
