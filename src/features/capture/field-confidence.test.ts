import { describe, expect, it } from 'vitest';
import { isSubstantialTitle } from './field-confidence';

describe('isSubstantialTitle (issue #716, Entscheidung B)', () => {
  it('ein einzelnes Füllwort ist nicht tragfähig', () => {
    expect(isSubstantialTitle('eher')).toBe(false);
  });

  it('mehrere Füllwörter zusammen sind nicht tragfähig', () => {
    expect(isSubstantialTitle('so noch')).toBe(false);
  });

  it('eine Kurzform unter drei Zeichen ist nicht tragfähig', () => {
    expect(isSubstantialTitle('ca')).toBe(false);
  });

  it('ein echtes Inhaltswort ist tragfähig', () => {
    expect(isSubstantialTitle('Zahnarzt')).toBe(true);
  });

  it('leerer Text ist nicht tragfähig', () => {
    expect(isSubstantialTitle('')).toBe(false);
  });

  it('nur Leerraum ist nicht tragfähig (Kantentrim)', () => {
    expect(isSubstantialTitle('   ')).toBe(false);
  });

  it('ein Füllwort neben einem Inhaltswort ist tragfähig — genau ein Inhaltstoken reicht', () => {
    expect(isSubstantialTitle('eher Gesundheit')).toBe(true);
  });
});
