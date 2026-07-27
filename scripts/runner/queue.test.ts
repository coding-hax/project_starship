import { describe, expect, it } from 'vitest';
import { queueOrderFlat, queuePending, type QueueIssue } from './queue';

// #271: die queueNext-Faelle stehen jetzt in select.test.ts -- dort, wo die
// Kaskade lebt, die sie beschreiben. Hier bleibt, was wirklich zu queue.ts
// gehoert: das Lesen des Queue-Bodys und die Zaehlung offener Arbeit.

function label(name: string) {
  return { name };
}

describe('queueOrderFlat', () => {
  it('reads every #NN in document order, deduplicated', () => {
    expect(queueOrderFlat('#99\n#10\n#99')).toEqual([99, 10]);
  });

  it('returns [] for an empty or missing body', () => {
    expect(queueOrderFlat('')).toEqual([]);
  });

  it('counts every #NN, including ones inside note blocks (known trap, not a bug)', () => {
    expect(queueOrderFlat('# Queue\n#77 -- als naechstes\n\n> Notiz: siehe #12 fuer Kontext')).toEqual([
      77, 12,
    ]);
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
