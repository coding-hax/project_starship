// Der Parser aus #839 -- die Liste, gegen die spaeter jeder Befund des
// Check-Laufs nummeriert wird. Zwei Fehlerklassen sind hier teuer und deshalb
// einzeln festgenagelt:
//
//   1. ZU WENIG gefunden -> das Tor parkt ein Ticket, das in Ordnung ist.
//   2. ZU VIEL gefunden  -> die Nummerierung verschiebt sich gegen das, was im
//      Ticket steht, und "AK 3 nicht erfuellt" zeigt auf das falsche Kriterium.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptanceCriteria, hasAcceptanceCriteria, missingCriteriaComment } from './ak';

const ROOT = join(__dirname, '..', '..');

describe('acceptanceCriteria', () => {
  it('reads numbered items under the heading', () => {
    const body = ['## Ziel', 'egal', '', '## Akzeptanzkriterien', '', '1. Erstens', '2. Zweitens'].join('\n');
    expect(acceptanceCriteria(body)).toEqual(['Erstens', 'Zweitens']);
  });

  it('reads checkbox items, checked and unchecked alike', () => {
    const body = '## Akzeptanzkriterien\n\n- [ ] Offen\n- [x] Erledigt\n* [ ] Auch mit Stern';
    expect(acceptanceCriteria(body)).toEqual(['Offen', 'Erledigt', 'Auch mit Stern']);
  });

  it('accepts "1)" as well as "1."', () => {
    expect(acceptanceCriteria('## Akzeptanzkriterien\n1) Eins\n2) Zwei')).toEqual(['Eins', 'Zwei']);
  });

  // Der Normalfall in diesem Repo: die Tickets brechen bei ~78 Zeichen um.
  it('joins wrapped continuation lines into the criterion above', () => {
    const body = '## Akzeptanzkriterien\n\n1. Given ich bin offline,\n   When ich speichere,\n   Then steht es da.';
    expect(acceptanceCriteria(body)).toEqual(['Given ich bin offline, When ich speichere, Then steht es da.']);
  });

  // Die teure Verwechslung: ein eingerueckter Unterpunkt ist Fortsetzung,
  // kein eigenes Kriterium -- sonst verschiebt sich die Nummerierung.
  it('treats an indented bullet as continuation, not as its own criterion', () => {
    const body = '## Akzeptanzkriterien\n\n1. Kopf bleibt vollstaendig:\n   - Unterzeile\n   - Ring\n2. Nichts laeuft ueber.';
    expect(acceptanceCriteria(body)).toEqual(['Kopf bleibt vollstaendig: - Unterzeile - Ring', 'Nichts laeuft ueber.']);
  });

  it('stops at the next heading of any level', () => {
    const body = '## Akzeptanzkriterien\n\n1. Eins\n\n### Betroffene Dateien\n\n- `src/a.ts`\n\n## Nicht-Ziele\n\n1. Nicht das hier';
    expect(acceptanceCriteria(body)).toEqual(['Eins']);
  });

  it('finds the section at any heading level and with a trailing colon', () => {
    expect(acceptanceCriteria('# Akzeptanzkriterien:\n1. Eins')).toEqual(['Eins']);
    expect(acceptanceCriteria('#### Akzeptanzkriterium\n1. Eins')).toEqual(['Eins']);
  });

  // Gemessen an den offenen Tickets: #854, #855 und #856 schreiben
  // '## Akzeptanzkriterien (Entwurf)' und haben darunter saubere Listen. Ohne
  // diese Toleranz parkte das Tor sie wegen eines Klammerzusatzes.
  it('accepts a suffix after the heading word', () => {
    expect(acceptanceCriteria('## Akzeptanzkriterien (Entwurf)\n1. Eins')).toEqual(['Eins']);
    expect(acceptanceCriteria('## Akzeptanzkriterien (Entwurf, der Plan-Lauf schaerft)\n1. Eins')).toEqual(['Eins']);
  });

  // #847 fuehrt seine Kriterien als schlichte Punkte ('- **AK1** ...'). Das
  // ist eine Aufzaehlung, kein Fliesstext -- ausgeschlossen sein soll das
  // zweite, nicht das erste.
  it('reads plain bullets, not only checkboxes and numbers', () => {
    const body = '## Akzeptanzkriterien\n\n- **AK1** Die Lupe oeffnet die Suche.\n* AK2 Eine Eingabe verengt die Liste.';
    expect(acceptanceCriteria(body)).toEqual(['**AK1** Die Lupe oeffnet die Suche.', 'AK2 Eine Eingabe verengt die Liste.']);
  });

  // #891 fuehrt eine vierte Form: die fette Marke OHNE Aufzaehlungszeichen.
  // Der Parser erkannte bisher nur '- **AK1** ...' (siehe oben), nicht
  // '**AK1** ...' -- genau das Format von #891, das das Tor faelschlich in
  // needs-answer schickte.
  it('reads bold markers without a leading bullet', () => {
    const body = '## Akzeptanzkriterien\n\n**AK1** Erstens.\n**AK2** Zweitens.';
    expect(acceptanceCriteria(body)).toEqual(['**AK1** Erstens.', '**AK2** Zweitens.']);
  });

  it('joins continuation lines under a bullet-less bold marker', () => {
    const body = '## Akzeptanzkriterien\n\n**AK1** Kopf\nzweite Zeile\n**AK2** Zweitens.';
    expect(acceptanceCriteria(body)).toEqual(['**AK1** Kopf zweite Zeile', '**AK2** Zweitens.']);
  });

  // Streng beim Inhalt: fette Zeilen, die keine AK-Marke sind, bleiben
  // Fliesstext -- sonst zaehlte jedes '**Wichtig:** ...' als Kriterium.
  it('does not treat arbitrary bold prose as a bullet-less marker', () => {
    const body = '## Akzeptanzkriterien\n\n**Wichtig:** Das Ding soll schnell sein.';
    expect(acceptanceCriteria(body)).toEqual([]);
  });

  // Kernaussage von AK1: Prosa ist keine Spezifikation.
  it('ignores prose without a list', () => {
    expect(acceptanceCriteria('## Akzeptanzkriterien\n\nDas Ding soll schnell sein.')).toEqual([]);
  });

  it('ignores list items outside the section', () => {
    expect(acceptanceCriteria('## Ziel\n\n1. Kein Kriterium\n\n## Hinweise\n\n1. Auch nicht')).toEqual([]);
  });

  it('returns nothing for a missing section or an empty body', () => {
    expect(acceptanceCriteria('## Ziel\n\nEin Satz.')).toEqual([]);
    expect(acceptanceCriteria('')).toEqual([]);
  });

  it('does not trigger on prose mentioning the word mid-line', () => {
    expect(acceptanceCriteria('Die ## Akzeptanzkriterien fehlen noch.\n1. Eins')).toEqual([]);
  });
});

describe('hasAcceptanceCriteria', () => {
  it('is the gate from AK2 in one word', () => {
    expect(hasAcceptanceCriteria('## Akzeptanzkriterien\n1. Eins')).toBe(true);
    expect(hasAcceptanceCriteria('## Akzeptanzkriterien\n\nProsa.')).toBe(false);
    expect(hasAcceptanceCriteria('')).toBe(false);
  });

  // #891 haette das Tor sonst weiterhin faelschlich sperren lassen.
  it('recognizes a bullet-less **AKn** body like #891', () => {
    expect(hasAcceptanceCriteria('## Akzeptanzkriterien\n\n**AK1** Erstens.')).toBe(true);
  });
});

// Haelt Template und Parser zusammen -- dieselbe Idee wie label-contract.test.ts.
// Ein Template, dessen eigener AK-Abschnitt durch das Tor fiele, waere eine
// Falle fuer jedes daraus geschriebene Ticket.
describe('issue template', () => {
  it('parses to at least one criterion', () => {
    const template = readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'feature.md'), 'utf-8');
    expect(acceptanceCriteria(template).length).toBeGreaterThan(0);
  });
});

describe('missingCriteriaComment', () => {
  it('names the issue and the way out', () => {
    const text = missingCriteriaComment(42);
    expect(text).toContain('#42');
    expect(text).toContain('## Akzeptanzkriterien');
    expect(text).toContain('needs-answer');
  });
});
