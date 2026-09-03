import { describe, expect, it } from 'vitest';
import { CURATED_CASES } from './curated';
import { generateGoldCases, generateHardCases } from './generate';
import { pct, scoreCorpus } from './score';
import type { Bucket, GoldField, GoldResult } from './score';

/**
 * Das Gate über dem Erfassungspfad: jeder Fall des Goldkorpus muss stimmen.
 *
 * Der Bericht wird nur bei einem Fehlschlag gedruckt — im grünen Fall bleibt eine Zeile
 * übrig, sonst ertränke er jeden CI-Lauf. Wer die Grammatik ändert und hier rot wird,
 * hat entweder einen Rückschritt gebaut oder eine Regel geändert; im zweiten Fall gehört
 * der neue Sollwert nach `curated.ts` bzw. in die Slot-Tabellen — nicht diese Schwelle
 * heruntergesetzt.
 */
describe('Goldkorpus', () => {
  it('der lokale Erkenner trifft jeden Fall', () => {
    const cases = [...CURATED_CASES, ...generateGoldCases(), ...generateHardCases()];
    const report = scoreCorpus(cases);

    if (report.failures.length > 0) printReport(report);

    expect(
      report.failures.length,
      `${report.failures.length} von ${report.overall.total} Fällen falsch — Bericht oben`,
    ).toBe(0);
  });
});

function printReport(report: ReturnType<typeof scoreCorpus>): void {
  const line = (label: string, b: Bucket) =>
    `${label.padEnd(30)} ${String(b.total).padStart(6)}  ${pct(b.ok, b.total)}   ` +
    (['kind', 'title', 'dueAt', 'habitId'] as GoldField[])
      .map((f) => `${f}:${pct(b.fields[f].ok, b.fields[f].checked)}`)
      .join('  ');

  console.log('\n' + 'KATEGORIE'.padEnd(30) + '  FÄLLE  GESAMT   je Feld');
  console.log('─'.repeat(92));
  console.log(line('ALLE', report.overall));
  console.log('─'.repeat(92));
  const sorted = [...report.byCategory.entries()].sort(
    (a, b) => a[1].ok / a[1].total - b[1].ok / b[1].total,
  );
  for (const [name, bucket] of sorted) {
    if (bucket.ok < bucket.total) console.log(line(name, bucket));
  }

  // Höchstens drei Beispiele je Kategorie und Fehlerart — sonst ist der Bericht unlesbar.
  const seen = new Map<string, number>();
  const show = (r: GoldResult) => {
    const bad = Object.entries(r.fields)
      .filter(([, ok]) => !ok)
      .map(([field]) => field);
    const key = r.case.category + bad.join();
    const count = seen.get(key) ?? 0;
    if (count >= 3) return;
    seen.set(key, count + 1);
    console.log(`\n  „${r.case.text}"   [${r.case.category}, ${r.case.id}]  falsch: ${bad.join(', ')}`);
    if (bad.includes('kind')) console.log(`      art    soll ${r.case.expect.kind}   ist ${r.actual.kind}`);
    if (bad.includes('title')) console.log(`      titel  soll „${r.case.expect.title}"   ist „${r.actual.title}"`);
    if (bad.includes('dueAt')) console.log(`      fällig soll ${r.case.expect.dueAt ?? '—'}   ist ${r.actual.dueAt ?? '—'}`);
    if (bad.includes('habitId')) console.log(`      habit  soll ${r.case.expect.habitId ?? '—'}   ist ${r.actual.habitId ?? '—'}`);
  };
  for (const failure of report.failures) show(failure);
  console.log('');
}
