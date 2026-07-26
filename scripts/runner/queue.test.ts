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

  it('counts a no-opus needs-plan ticket as pending', () => {
    const snap: QueueIssue[] = [
      { number: 50, labels: [label('needs-plan'), label('no-opus')] },
      { number: 51, labels: [label('ready')] },
    ];
    expect(queuePending(snap)).toBe('#50, #51');
  });

  it('returns "" for an empty queue', () => {
    expect(queuePending([{ number: 70, labels: [] }])).toBe('');
  });
});

describe('queueNext', () => {
  it('picks a running in-progress ticket over needs-plan and ready', () => {
    const snap: QueueIssue[] = [
      { number: 10, labels: [label('ready')] },
      { number: 20, labels: [label('needs-plan')] },
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

  it('skips a no-opus needs-plan ticket, falling back to ready', () => {
    const snap: QueueIssue[] = [
      { number: 50, labels: [label('needs-plan'), label('no-opus')] },
      { number: 51, labels: [label('ready')] },
    ];
    expect(queueNext(snap)).toBe(51);
  });

  it('returns null when only needs-research is open', () => {
    expect(queueNext([{ number: 60, labels: [label('needs-research')] }])).toBeNull();
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

  it('no-opus excludes a listed ticket, falling back to the plain queue/label logic', () => {
    const snap: QueueIssue[] = [
      { number: 77, labels: [label('no-opus')], createdAt: '2024-01-01T00:00:00Z' },
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
