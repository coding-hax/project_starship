import { expect, it } from 'vitest';
import {
  generateComplexCases, generateGoldCases, generateHardCases, generateSpokenCases,
  generateTelegramCases,
} from './generate';
it('kein Fall fällt durch die Filter des Gates', () => {
  const gen = generateGoldCases();
  const hard = generateHardCases();
  const spoken = generateSpokenCases();
  const tele = generateTelegramCases();
  const komplex = generateComplexCases();
  const covered =
    gen.filter((c) => ['gen:nackt', 'gen:datum', 'gen:routine', 'gen:termin-vorn', 'gen:termin-hinten'].some((p) => c.id.startsWith(p))).length +
    hard.filter((c) => ['hard:rahmen', 'hard:praeposition'].some((p) => c.id.startsWith(p))).length +
    spoken.filter((c) => ['spoken:kopf:', 'spoken:kopf-datum', 'spoken:aussage', 'spoken:zoegern:', 'spoken:zoegern-aussage'].some((p) => c.id.startsWith(p))).length +
    tele.filter((c) => ['tele:kuerzel-zeit', 'tele:kuerzel-punkt', 'tele:kuerzel-kurzzeit', 'tele:kurzzeit'].some((p) => c.id.startsWith(p))).length +
    komplex.filter((c) => ['komplex:spanne', 'komplex:wiederholung'].some((p) => c.id.startsWith(p))).length;
  expect(covered).toBe(gen.length + hard.length + spoken.length + tele.length + komplex.length);
});
