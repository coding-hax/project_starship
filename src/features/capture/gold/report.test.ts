import { describe, it } from 'vitest';
import { CURATED_CASES } from './curated';
import { generateGoldCases, generateHardCases } from './generate';
import { pct, scoreCorpus } from './score';
import type { Bucket, GoldField, GoldResult } from './score';

/**
 * Messwerkzeug, kein Gate: druckt die Trefferquote des Erkenners gegen das Goldkorpus.
 * Failt (noch) nicht — solange die Quote unter 100 % liegt, wäre ein Gate hier nur eine
 * dauerrote CI. Der Schwellwert kommt, wenn die Grammatik so weit ist.
 */
describe('Goldkorpus — Bericht', () => {
  it('misst den lokalen Erkenner', () => {
    const cases = [...CURATED_CASES, ...generateGoldCases(), ...generateHardCases()];
    const report = scoreCorpus(cases);

    const line = (label: string, b: Bucket) =>
      `${label.padEnd(30)} ${String(b.total).padStart(6)}  ${pct(b.ok, b.total)}   ` +
      (['kind', 'title', 'dueAt', 'habitId'] as GoldField[])
        .map((f) => `${f}:${pct(b.fields[f].ok, b.fields[f].checked)}`)
        .join('  ');

    console.log('\n╔══ GOLDKORPUS ' + '═'.repeat(76));
    console.log(`Fälle: ${report.overall.total}   komplett richtig: ${pct(report.overall.ok, report.overall.total)}`);
    console.log('\n' + 'KATEGORIE'.padEnd(30) + '  FÄLLE  GESAMT   je Feld');
    console.log('─'.repeat(92));
    console.log(line('ALLE', report.overall));
    console.log('─'.repeat(92));
    const sorted = [...report.byCategory.entries()].sort((a, b) => a[1].ok / a[1].total - b[1].ok / b[1].total);
    for (const [name, bucket] of sorted) console.log(line(name, bucket));

    // Fehlerbeispiele, je Kategorie höchstens drei — sonst ertrinkt der Bericht.
    console.log('\n╔══ FEHLERBEISPIELE ' + '═'.repeat(71));
    const seen = new Map<string, number>();
    const show = (r: GoldResult) => {
      const key = r.case.category + Object.entries(r.fields).filter(([, v]) => !v).map(([k]) => k).join();
      const count = seen.get(key) ?? 0;
      if (count >= 3) return;
      seen.set(key, count + 1);
      const bad = Object.entries(r.fields).filter(([, v]) => !v).map(([k]) => k);
      console.log(`\n  „${r.case.text}"   [${r.case.category}]  falsch: ${bad.join(', ')}`);
      if (bad.includes('kind')) console.log(`      art    soll ${r.case.expect.kind}   ist ${r.actual.kind}`);
      if (bad.includes('title')) console.log(`      titel  soll „${r.case.expect.title}"   ist „${r.actual.title}"`);
      if (bad.includes('dueAt')) console.log(`      fällig soll ${r.case.expect.dueAt ?? '—'}   ist ${r.actual.dueAt ?? '—'}`);
      if (bad.includes('habitId')) console.log(`      habit  soll ${r.case.expect.habitId ?? '—'}   ist ${r.actual.habitId ?? '—'}`);
    };
    for (const f of report.failures) show(f);
    console.log('');
  });
});
