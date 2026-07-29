import { describe, expect, it } from 'vitest';
import {
  queueBlocked,
  queueCycles,
  queueDone,
  queueEntries,
  queueOrderFlat,
  queuePending,
  TRIAGE_LABELS,
  untriaged,
  type QueueIssue,
} from './queue';

// #271: die queueNext-Faelle stehen jetzt in select.test.ts -- dort, wo die
// Kaskade lebt, die sie beschreiben. Hier bleibt, was wirklich zu queue.ts
// gehoert: das Lesen des Queue-Bodys und die Zaehlung offener Arbeit.

function label(name: string) {
  return { name };
}

describe('queueOrderFlat', () => {
  it('reads every entry in document order, deduplicated', () => {
    expect(queueOrderFlat('- #99\n- #10\n- #99')).toEqual([99, 10]);
  });

  it('returns [] for an empty or missing body', () => {
    expect(queueOrderFlat('')).toEqual([]);
  });

  // #265 AC3: Hier stand bis heute das Gegenteil -- "zaehlt jede #NN, auch in
  // Notizen (bekannte Falle, kein Bug)". Die Falle war real: eine Raute im
  // Fliesstext reihte still ein fremdes Ticket ein, und dagegen half nur eine
  // Warnung in Issue 92, an die jemand denken musste.
  it('ignores #NN outside an entry line -- notes may contain ticket numbers again', () => {
    expect(queueOrderFlat('# Queue\n- #77 als naechstes\n\n> Notiz: siehe #12 fuer Kontext')).toEqual([77]);
  });

  it('needs the leading dash: a bare "#77" line is not an entry', () => {
    expect(queueOrderFlat('#77')).toEqual([]);
  });

  // Eingerücktes zählt bewusst nicht: nur so lässt sich das Format im
  // Queue-Issue selbst dokumentieren, ohne dass die Beispiele Tickets
  // einreihen. Der Irrtum geht damit in die sichere Richtung -- nicht gebaut
  // statt versehentlich gebaut.
  it('an indented "- #77" is a note, not an entry', () => {
    expect(queueOrderFlat('  - #77')).toEqual([]);
    expect(queueOrderFlat('\t- #77')).toEqual([]);
  });
});

// #265: Abhaengigkeiten stehen als Daten in derselben Zeile, statt als Prosa
// ("ready, sobald 239 gemerged ist"). Die Prosa-Variante verlangte nach jedem
// Merge eine Handlung vom Menschen -- das hat nachweislich nicht funktioniert.
describe('queueEntries (#265)', () => {
  it('reads the first number as the entry and the rest as prerequisites', () => {
    expect(queueEntries('- #266 nach #227 #225')).toEqual([{ issue: 266, after: [227, 225] }]);
  });

  it('entry without prerequisites has an empty after-list', () => {
    expect(queueEntries('- #266')).toEqual([{ issue: 266, after: [] }]);
  });

  it('the word between the numbers is decoration -- it is never parsed', () => {
    expect(queueEntries('- #266 braucht #227')).toEqual(queueEntries('- #266 nach #227'));
  });

  it('keeps the first mention of a duplicated entry', () => {
    expect(queueEntries('- #266 nach #227\n- #266')).toEqual([{ issue: 266, after: [227] }]);
  });
});

describe('queueBlocked / queueDone (#265)', () => {
  const entries = queueEntries('- #266 nach #227 #225\n- #241 nach #239\n- #300');

  it('a prerequisite counts as met once its ticket is no longer open', () => {
    // Offen sind 266, 241, 300 und 227 -- 225 und 239 sind geschlossen.
    const blocked = queueBlocked(entries, new Set([266, 241, 300, 227]));
    expect(blocked.get(266)).toEqual([227]);
    expect(blocked.has(241)).toBe(false);
    expect(blocked.has(300)).toBe(false);
  });

  it('a prerequisite that does not exist at all counts as met, not as a permanent block', () => {
    expect(queueBlocked(queueEntries('- #266 nach #99999'), new Set([266])).size).toBe(0);
  });

  it('lists entries whose own ticket is closed -- the human strikes them, not the runner', () => {
    expect(queueDone(entries, new Set([266]))).toEqual([241, 300]);
  });
});

describe('queueCycles (#265)', () => {
  it('finds two entries waiting for each other', () => {
    expect(queueCycles(queueEntries('- #1 nach #2\n- #2 nach #1'))).toEqual([1, 2]);
  });

  it('finds a longer ring', () => {
    expect(queueCycles(queueEntries('- #1 nach #2\n- #2 nach #3\n- #3 nach #1'))).toEqual([1, 2, 3]);
  });

  it('a chain is not a cycle', () => {
    expect(queueCycles(queueEntries('- #1 nach #2\n- #2 nach #3\n- #3'))).toEqual([]);
  });

  it('a dependency on a ticket outside the queue is not a cycle', () => {
    expect(queueCycles(queueEntries('- #1 nach #500'))).toEqual([]);
  });

  it('a diamond is not a cycle -- a node reachable twice is fine', () => {
    expect(queueCycles(queueEntries('- #1 nach #2 #3\n- #2 nach #4\n- #3 nach #4\n- #4'))).toEqual([]);
  });
});

describe('queuePending', () => {
  it('excludes a ticket that waits on the human', () => {
    const snap: QueueIssue[] = [
      { number: 40, labels: [label('ready'), label('needs-answer')] },
      { number: 41, labels: [label('ready')] },
    ];
    expect(queuePending(snap)).toBe('#41');
  });

  // #271 AC3: 'queuePending' zaehlt OFFENE ARBEIT, nicht Waehlbares -- ein
  // hands-off-Ticket ist offen, nur eben nicht fuer den Runner. Genau hier
  // duerfen die beiden Funktionen auseinandergehen.
  it('counts a hands-off plan ticket as pending', () => {
    const snap: QueueIssue[] = [
      { number: 50, labels: [label('plan'), label('hands-off')] },
      { number: 51, labels: [label('ready')] },
    ];
    expect(queuePending(snap)).toBe('#50, #51');
  });

  it('returns "" for an empty queue', () => {
    expect(queuePending([{ number: 70, labels: [] }])).toBe('');
  });
});

// #357, Owner-Entscheidung "C" (29.07.26): untriagierte Fund-Tickets sichtbar
// machen, statt sie still verrotten zu lassen -- ohne die Auswahl selbst zu
// aendern.
describe('untriaged (#357)', () => {
  const noMeta = new Set<number>();

  it('lists an open issue with no label at all, not in the queue', () => {
    const snap: QueueIssue[] = [{ number: 349, labels: [] }];
    expect(untriaged(snap, [], noMeta)).toEqual([349]);
  });

  it.each(TRIAGE_LABELS)('excludes an issue carrying the control label "%s"', (name) => {
    const snap: QueueIssue[] = [{ number: 1, labels: [label(name)] }];
    expect(untriaged(snap, [], noMeta)).toEqual([]);
  });

  it('excludes a labelless issue that is a queue entry', () => {
    const snap: QueueIssue[] = [{ number: 300, labels: [] }];
    expect(untriaged(snap, queueEntries('- #300'), noMeta)).toEqual([]);
  });

  it('excludes the meta issues (status + queue) even though they are open and labelless', () => {
    const snap: QueueIssue[] = [
      { number: 1, labels: [] },
      { number: 92, labels: [] },
      { number: 349, labels: [] },
    ];
    expect(untriaged(snap, [], new Set([1, 92]))).toEqual([349]);
  });

  it('lists an issue carrying only a modifier label (e.g. model:sonnet)', () => {
    const snap: QueueIssue[] = [{ number: 349, labels: [label('model:sonnet')] }];
    expect(untriaged(snap, [], noMeta)).toEqual([349]);
  });

  it('sorts ascending, [] for an empty snapshot', () => {
    const snap: QueueIssue[] = [{ number: 400, labels: [] }, { number: 349, labels: [] }];
    expect(untriaged(snap, [], noMeta)).toEqual([349, 400]);
    expect(untriaged([], [], noMeta)).toEqual([]);
  });
});
