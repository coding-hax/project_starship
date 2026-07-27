import { describe, expect, it } from 'vitest';
import { queueNext, queueOrderFlat, queuePending, type QueueIssue } from './queue';

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
  it('excludes a needs-input ticket', () => {
    const snap: QueueIssue[] = [
      { number: 40, labels: [label('ready'), label('needs-input')] },
      { number: 41, labels: [label('ready')] },
    ];
    expect(queuePending(snap)).toBe('#41');
  });

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

describe('queueNext', () => {
  it('picks a running in-progress ticket over plan and ready', () => {
    const snap: QueueIssue[] = [
      { number: 10, labels: [label('ready')] },
      { number: 20, labels: [label('plan')] },
      { number: 30, labels: [label('in-progress')] },
    ];
    expect(queueNext(snap)).toBe(30);
  });

  it('skips a needs-input ticket, falling back to the next ready one', () => {
    const snap: QueueIssue[] = [
      { number: 40, labels: [label('ready'), label('needs-input')] },
      { number: 41, labels: [label('ready')] },
    ];
    expect(queueNext(snap)).toBe(41);
  });

  it('skips a hands-off plan ticket, falling back to ready', () => {
    const snap: QueueIssue[] = [
      { number: 50, labels: [label('plan'), label('hands-off')] },
      { number: 51, labels: [label('ready')] },
    ];
    expect(queueNext(snap)).toBe(51);
  });

  // #271 Punkt 1: der running-Zweig prueft hands-off bisher nicht -- die
  // Anzeige nannte ein laufendes Ticket, das die Auswahl laengst ueberspringt.
  it('skips a hands-off in-progress ticket, falling back to ready', () => {
    const snap: QueueIssue[] = [
      { number: 52, labels: [label('in-progress'), label('hands-off')] },
      { number: 53, labels: [label('ready')] },
    ];
    expect(queueNext(snap)).toBe(53);
  });

  // #271 Punkt 2: dasselbe im ready-Zweig.
  it('skips a hands-off ready ticket, falling back to the next ready one', () => {
    const snap: QueueIssue[] = [
      { number: 54, labels: [label('ready'), label('hands-off')], createdAt: '2024-01-01T00:00:00Z' },
      { number: 55, labels: [label('ready')], createdAt: '2024-01-02T00:00:00Z' },
    ];
    expect(queueNext(snap)).toBe(55);
  });

  it('returns null when every ticket carries hands-off', () => {
    const snap: QueueIssue[] = [
      { number: 56, labels: [label('in-progress'), label('hands-off')] },
      { number: 57, labels: [label('plan'), label('hands-off')] },
      { number: 58, labels: [label('ready'), label('hands-off')] },
    ];
    expect(queueNext(snap)).toBeNull();
  });

  it('returns null when only research is open', () => {
    expect(queueNext([{ number: 60, labels: [label('research')] }])).toBeNull();
  });

  it('returns null for an empty queue', () => {
    expect(queueNext([{ number: 70, labels: [] }])).toBeNull();
  });

  it('picks the oldest ticket within a stage by createdAt, not array order', () => {
    const snap: QueueIssue[] = [
      { number: 82, labels: [label('ready')], createdAt: '2024-06-01T00:00:00Z' },
      { number: 81, labels: [label('ready')], createdAt: '2024-01-01T00:00:00Z' },
    ];
    expect(queueNext(snap)).toBe(81);
  });

  it('listed ticket without any label still wins (label is irrelevant for the flat queue)', () => {
    const snap: QueueIssue[] = [{ number: 77, labels: [], createdAt: '2024-01-01T00:00:00Z' }];
    expect(queueNext(snap, '#77')).toBe(77);
  });

  it('queue order beats createdAt', () => {
    const snap: QueueIssue[] = [
      { number: 10, labels: [], createdAt: '2024-01-01T00:00:00Z' },
      { number: 99, labels: [], createdAt: '2024-06-01T00:00:00Z' },
    ];
    expect(queueNext(snap, '#99\n#10')).toBe(99);
  });

  it('a listed ticket beats an unlisted ready one', () => {
    const snap: QueueIssue[] = [
      { number: 10, labels: [label('ready')], createdAt: '2024-01-01T00:00:00Z' },
      { number: 99, labels: [], createdAt: '2024-06-01T00:00:00Z' },
    ];
    expect(queueNext(snap, '#99')).toBe(99);
  });

  it('needs-input excludes a listed ticket, falling back to the plain queue/label logic', () => {
    const snap: QueueIssue[] = [
      { number: 77, labels: [label('needs-input')], createdAt: '2024-01-01T00:00:00Z' },
      { number: 88, labels: [label('ready')], createdAt: '2024-02-01T00:00:00Z' },
    ];
    expect(queueNext(snap, '#77')).toBe(88);
  });

  it('hands-off excludes a listed ticket, falling back to the plain queue/label logic', () => {
    const snap: QueueIssue[] = [
      { number: 77, labels: [label('hands-off')], createdAt: '2024-01-01T00:00:00Z' },
      { number: 88, labels: [label('ready')], createdAt: '2024-02-01T00:00:00Z' },
    ];
    expect(queueNext(snap, '#77')).toBe(88);
  });

  it('empty queue body falls back to ready by oldest createdAt', () => {
    const snap: QueueIssue[] = [
      { number: 10, labels: [label('ready')], createdAt: '2024-01-01T00:00:00Z' },
      { number: 99, labels: [label('ready')], createdAt: '2024-06-01T00:00:00Z' },
    ];
    expect(queueNext(snap, '')).toBe(10);
  });
});
