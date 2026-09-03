import { expect, it } from 'vitest';
import { generateGoldCases, generateHardCases } from './generate';
it('kein Fall fällt durch die Filter des Gates', () => {
  const gen = generateGoldCases();
  const hard = generateHardCases();
  const covered =
    gen.filter((c) => ['gen:nackt', 'gen:datum', 'gen:routine', 'gen:termin-vorn', 'gen:termin-hinten'].some((p) => c.id.startsWith(p))).length +
    hard.filter((c) => ['hard:rahmen', 'hard:praeposition'].some((p) => c.id.startsWith(p))).length;
  expect(covered).toBe(gen.length + hard.length);
});
