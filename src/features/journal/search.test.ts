import { describe, expect, it } from 'vitest';
import { searchJournalEntries, type JournalSearchEntry } from './search';

function entry(entryDate: string, text: string, tags: string[] = []): JournalSearchEntry {
  return { entryDate, text, tags };
}

describe('searchJournalEntries', () => {
  it('findet Treffer im Text, case-insensitiv', () => {
    const entries = [entry('2026-07-01', 'Ein RUHIGER Tag'), entry('2026-07-02', 'Nichts Besonderes')];
    expect(searchJournalEntries(entries, 'ruhiger')).toEqual([entries[0]]);
  });

  it('findet Treffer in Tags, case-insensitiv', () => {
    const entries = [entry('2026-07-01', 'Text', ['Sport']), entry('2026-07-02', 'Text', ['Arbeit'])];
    expect(searchJournalEntries(entries, 'sport')).toEqual([entries[0]]);
  });

  it('liefert die neuesten Treffer zuerst', () => {
    const entries = [
      entry('2026-07-01', 'Lauf am Fluss'),
      entry('2026-07-03', 'Lauf im Wald'),
      entry('2026-07-02', 'Lauf im Park'),
    ];
    expect(searchJournalEntries(entries, 'lauf').map((e) => e.entryDate)).toEqual([
      '2026-07-03',
      '2026-07-02',
      '2026-07-01',
    ]);
  });

  it('leere oder reine Whitespace-Anfrage liefert keine Treffer', () => {
    const entries = [entry('2026-07-01', 'Irgendwas')];
    expect(searchJournalEntries(entries, '')).toEqual([]);
    expect(searchJournalEntries(entries, '   ')).toEqual([]);
  });

  it('kein Treffer liefert ein leeres Array', () => {
    const entries = [entry('2026-07-01', 'Irgendwas')];
    expect(searchJournalEntries(entries, 'nichtvorhanden')).toEqual([]);
  });

  it('bleibt mit 2000 Einträgen deutlich unter 100ms (AC4)', () => {
    const entries: JournalSearchEntry[] = Array.from({ length: 2000 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      return entry(`20${20 + Math.floor(i / 365)}-${month}-${day}`, `Eintrag Nummer ${i} über den Tag`, [
        `tag-${i % 10}`,
      ]);
    });

    const start = performance.now();
    const results = searchJournalEntries(entries, 'tag-3');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
