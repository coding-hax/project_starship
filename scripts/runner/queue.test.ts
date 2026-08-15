import { describe, expect, it } from 'vitest';
import {
  entriesFromIssues,
  parseAfter,
  queueBlocked,
  queueCycles,
  queuePending,
  TRIAGE_LABELS,
  untriaged,
  type QueueEntry,
  type QueueIssue,
} from './queue';

// #271: die queueNext-Faelle stehen jetzt in select.test.ts -- dort, wo die
// Kaskade lebt, die sie beschreiben. Hier bleibt, was wirklich zu queue.ts
// gehoert: das Lesen der 'Nach:'-Ketten aus Ticket-Bodies und die Zaehlung
// offener Arbeit. #725 (S2 von ADR-0023): der Rang selbst ('- #NN' im
// Queue-Issue-Body) ist mit dem Queue-Issue weg -- der Rang ist jetzt das
// Label `next` (select.test.ts).

function label(name: string) {
  return { name };
}

describe('queueBlocked (#265)', () => {
  const entries: QueueEntry[] = [
    { issue: 266, after: [227, 225] },
    { issue: 241, after: [239] },
    { issue: 300, after: [] },
  ];

  it('a prerequisite counts as met once its ticket is no longer open', () => {
    // Offen sind 266, 241, 300 und 227 -- 225 und 239 sind geschlossen.
    const blocked = queueBlocked(entries, new Set([266, 241, 300, 227]));
    expect(blocked.get(266)).toEqual([227]);
    expect(blocked.has(241)).toBe(false);
    expect(blocked.has(300)).toBe(false);
  });

  it('a prerequisite that does not exist at all counts as met, not as a permanent block', () => {
    expect(queueBlocked([{ issue: 266, after: [99999] }], new Set([266])).size).toBe(0);
  });
});

describe('queueCycles (#265)', () => {
  it('finds two entries waiting for each other', () => {
    expect(
      queueCycles([
        { issue: 1, after: [2] },
        { issue: 2, after: [1] },
      ]),
    ).toEqual([1, 2]);
  });

  it('finds a longer ring', () => {
    expect(
      queueCycles([
        { issue: 1, after: [2] },
        { issue: 2, after: [3] },
        { issue: 3, after: [1] },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it('a chain is not a cycle', () => {
    expect(
      queueCycles([
        { issue: 1, after: [2] },
        { issue: 2, after: [3] },
        { issue: 3, after: [] },
      ]),
    ).toEqual([]);
  });

  it('a dependency on a ticket outside the queue is not a cycle', () => {
    expect(queueCycles([{ issue: 1, after: [500] }])).toEqual([]);
  });

  it('a diamond is not a cycle -- a node reachable twice is fine', () => {
    expect(
      queueCycles([
        { issue: 1, after: [2, 3] },
        { issue: 2, after: [4] },
        { issue: 3, after: [4] },
        { issue: 4, after: [] },
      ]),
    ).toEqual([]);
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
// aendern. #725 (AK8): 'untriaged()' verliert den Parameter 'entries' -- es
// gibt keine Liste mehr, an der ein Ticket "gelistet" sein koennte.
describe('untriaged (#357)', () => {
  const noMeta = new Set<number>();

  it('lists an open issue with no label at all', () => {
    const snap: QueueIssue[] = [{ number: 349, labels: [] }];
    expect(untriaged(snap, noMeta)).toEqual([349]);
  });

  it.each(TRIAGE_LABELS)('excludes an issue carrying the control label "%s"', (name) => {
    const snap: QueueIssue[] = [{ number: 1, labels: [label(name)] }];
    expect(untriaged(snap, noMeta)).toEqual([]);
  });

  // #725 (AK8): ohne Queue-Issue gibt es keine Liste mehr, an der ein Ticket
  // "gelistet" sein koennte -- eine 'Nach:'-Zeile im eigenen Body macht ein
  // Ticket NICHT triagiert, anders als frueher ein Queue-Eintrag.
  it('still lists an issue whose own body carries a "Nach:" chain but no control label', () => {
    const snap: QueueIssue[] = [{ number: 300, labels: [], body: 'Nach: #227' }];
    expect(untriaged(snap, noMeta)).toEqual([300]);
  });

  it('excludes the status issue even though it is open and labelless', () => {
    const snap: QueueIssue[] = [
      { number: 1, labels: [] },
      { number: 349, labels: [] },
    ];
    expect(untriaged(snap, new Set([1]))).toEqual([349]);
  });

  it('lists an issue carrying only a modifier label (e.g. model:sonnet)', () => {
    const snap: QueueIssue[] = [{ number: 349, labels: [label('model:sonnet')] }];
    expect(untriaged(snap, noMeta)).toEqual([349]);
  });

  it('sorts ascending, [] for an empty snapshot', () => {
    const snap: QueueIssue[] = [{ number: 400, labels: [] }, { number: 349, labels: [] }];
    expect(untriaged(snap, noMeta)).toEqual([349, 400]);
    expect(untriaged([], noMeta)).toEqual([]);
  });

  // Ein Ticket mit Rollen-Label ist triagiert, egal wer es angelegt hat --
  // urspruenglich an selbst angelegten Fund-Tickets aufgefallen (#397). Die
  // legt der Runner seit #588 nicht mehr an; die Regel gilt unveraendert
  // fuer jedes Ticket, das schon ein Label traegt.
  it('excludes a ticket that already carries plan', () => {
    const snap: QueueIssue[] = [{ number: 349, labels: [label('plan')], body: 'irgendein Tickettext' }];
    expect(untriaged(snap, noMeta)).toEqual([]);
  });
});

// #724 (S1 von ADR-0023), seit #725 die einzige Quelle: die Kette steht als
// 'Nach: #687'-Zeile im TICKET-Body.
describe('parseAfter (#724)', () => {
  it('reads a single "Nach: #687" line', () => {
    expect(parseAfter('Nach: #687')).toEqual([687]);
  });

  it('reads multiple numbers on the same line', () => {
    expect(parseAfter('Nach: #687 #690')).toEqual([687, 690]);
  });

  it('reads multiple "Nach:" lines', () => {
    expect(parseAfter('Nach: #687\nsonstiger Text\nNach: #690')).toEqual([687, 690]);
  });

  it('deduplicates across lines', () => {
    expect(parseAfter('Nach: #687\nNach: #687 #690')).toEqual([687, 690]);
  });

  // Dieselbe Vorsicht wie bei ENTRY_LINE frueher (#265): Fliesstext triggert
  // nicht, nur eine Zeile, die exakt mit 'Nach:' beginnt.
  it('does not trigger on prose mentioning "nach", even mid-line "Nach: #NN"', () => {
    expect(parseAfter('läuft erst nach #687')).toEqual([]);
    expect(parseAfter('Startet erst Nach: #687, wenn die Sache fertig ist.')).toEqual([]);
  });

  it('an indented "Nach:" line does not count', () => {
    expect(parseAfter('  Nach: #687')).toEqual([]);
  });

  it('returns [] for an empty or missing body', () => {
    expect(parseAfter('')).toEqual([]);
  });
});

describe('entriesFromIssues (#724)', () => {
  it('reads a QueueEntry per issue that carries a "Nach:" line', () => {
    const snap: QueueIssue[] = [
      { number: 712, labels: [], body: 'Nach: #711' },
      { number: 713, labels: [], body: 'Nach: #711 #712' },
    ];
    expect(entriesFromIssues(snap)).toEqual([
      { issue: 712, after: [711] },
      { issue: 713, after: [711, 712] },
    ]);
  });

  it('omits an issue without a "Nach:" line -- no empty entry', () => {
    const snap: QueueIssue[] = [{ number: 300, labels: [], body: 'kein Nach hier' }];
    expect(entriesFromIssues(snap)).toEqual([]);
  });

  it('treats a missing body like an empty one', () => {
    const snap: QueueIssue[] = [{ number: 300, labels: [] }];
    expect(entriesFromIssues(snap)).toEqual([]);
  });
});
