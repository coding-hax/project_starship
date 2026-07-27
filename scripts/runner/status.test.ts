import { describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import { queueBody, queueSnapshot, waitingIssues } from './status';

function ghRouter(routes: Record<string, string>): GhAdapter {
  return {
    run: vi.fn((args: string[]) => {
      const key = args.join(' ');
      for (const [pattern, out] of Object.entries(routes)) {
        if (key.startsWith(pattern)) return out;
      }
      throw new Error(`kein Route-Stub fuer: ${key}`);
    }),
  };
}

function throwingGh(): GhAdapter {
  return {
    run: vi.fn(() => {
      throw new Error('gh failed');
    }),
  };
}

// #272: Hier standen bis S2b sechs Funktionen -- waitingIssues, answerIssues,
// approveIssues, parkedIssues, parkedAnswerIssues, parkedApproveIssues -- also
// das Kreuzprodukt aus zwei Wartelabeln und dem 'parked'-Zustand. Mit genau
// einem Wartelabel und ohne Parken bleibt eine einzige Abfrage uebrig. Die
// entfallenen Tests deckten Funktionen ab, die es nicht mehr gibt; was hier
// bleibt, prueft dafuer schaerfer, dass wirklich 'needs-answer' abgefragt wird.
describe('waitingIssues', () => {
  it('reicht die serverseitig gefilterte Liste unveraendert durch', () => {
    const gh = ghRouter({ 'issue list --label needs-answer': '#12, #47' });
    expect(waitingIssues(gh)).toBe('#12, #47');
  });

  it('fragt genau needs-answer ab -- nicht das abgeschaffte needs-input', () => {
    const gh = ghRouter({ 'issue list --label needs-answer': '' });
    waitingIssues(gh);
    const args = (gh.run as unknown as { mock: { calls: [string[]][] } }).mock.calls[0]![0];
    expect(args).toContain('needs-answer');
    expect(args).not.toContain('needs-input');
    expect(args).not.toContain('parked');
  });

  it('fragt nur offene Tickets ab', () => {
    const gh = ghRouter({ 'issue list --label needs-answer': '' });
    waitingIssues(gh);
    expect(gh.run).toHaveBeenCalledWith(expect.arrayContaining(['--state', 'open']));
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    expect(waitingIssues(throwingGh())).toBe('');
  });
});

describe('queueSnapshot', () => {
  it('parst den Schnappschuss inkl. createdAt', () => {
    const gh = ghRouter({
      'issue list --state open': JSON.stringify([{ number: 1, labels: [{ name: 'ready' }], createdAt: '2024-01-01T00:00:00Z' }]),
    });
    expect(queueSnapshot(gh)).toEqual([{ number: 1, labels: [{ name: 'ready' }], createdAt: '2024-01-01T00:00:00Z' }]);
  });

  it('leeres Array statt Fehler, wenn gh scheitert', () => {
    expect(queueSnapshot(throwingGh())).toEqual([]);
  });

  it('leeres Array statt Absturz bei kaputtem JSON', () => {
    const gh = ghRouter({ 'issue list --state open': 'kein json' });
    expect(queueSnapshot(gh)).toEqual([]);
  });
});

describe('queueBody', () => {
  it('leer, wenn kein QUEUE_ISSUE gesetzt (<= 0)', () => {
    const gh = ghRouter({});
    expect(queueBody(0, gh)).toBe('');
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('holt den Body ueber gh issue view', () => {
    const gh = ghRouter({ 'issue view 92': '#10\n#20' });
    expect(queueBody(92, gh)).toBe('#10\n#20');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    expect(queueBody(92, throwingGh())).toBe('');
  });
});
