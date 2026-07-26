import { describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import {
  answerIssues,
  approveIssues,
  parkedAnswerIssues,
  parkedApproveIssues,
  parkIssue,
  parkedIssues,
  queueBody,
  queueSnapshot,
  waitingIssues,
} from './status';

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

describe('waitingIssues', () => {
  it('reicht die serverseitig gefilterte Liste unveraendert durch', () => {
    const gh = ghRouter({ 'issue list --label needs-input': '#12, #47' });
    expect(waitingIssues(gh)).toBe('#12, #47');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(waitingIssues(gh)).toBe('');
  });
});

describe('answerIssues (#196)', () => {
  it('fragt beide Labels serverseitig ab (AND)', () => {
    const gh = ghRouter({ 'issue list --label needs-input --label needs-answer': '#12' });
    expect(answerIssues(gh)).toBe('#12');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(answerIssues(gh)).toBe('');
  });
});

describe('approveIssues (#196)', () => {
  it('fragt needs-input ab und reicht den jq-gefilterten Rest durch', () => {
    const gh = ghRouter({ 'issue list --label needs-input': '#47' });
    expect(approveIssues(gh)).toBe('#47');
    expect(gh.run).toHaveBeenCalledWith(
      expect.arrayContaining(['--label', 'needs-input', '--json', 'number,labels']),
    );
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(approveIssues(gh)).toBe('');
  });
});

describe('parkedIssues', () => {
  it('reicht die serverseitig gefilterte Liste unveraendert durch', () => {
    const gh = ghRouter({ 'issue list --label parked': '#61' });
    expect(parkedIssues(gh)).toBe('#61');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(parkedIssues(gh)).toBe('');
  });
});

describe('parkedAnswerIssues (#196)', () => {
  it('fragt beide Labels serverseitig ab (AND)', () => {
    const gh = ghRouter({ 'issue list --label parked --label needs-answer': '#61' });
    expect(parkedAnswerIssues(gh)).toBe('#61');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(parkedAnswerIssues(gh)).toBe('');
  });
});

describe('parkedApproveIssues (#196)', () => {
  it('fragt parked ab und reicht den jq-gefilterten Rest durch', () => {
    const gh = ghRouter({ 'issue list --label parked': '#61' });
    expect(parkedApproveIssues(gh)).toBe('#61');
  });

  it('leer statt Fehler, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(parkedApproveIssues(gh)).toBe('');
  });
});

describe('parkIssue', () => {
  it('nimmt in-progress ab und gibt parked, true bei Erfolg', () => {
    const gh = ghRouter({ 'issue edit': '' });
    expect(parkIssue(50, gh)).toBe(true);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '50', '--remove-label', 'in-progress', '--add-label', 'parked']);
  });

  it('false, wenn gh scheitert (Sicherheitsnetz greift danach)', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(parkIssue(50, gh)).toBe(false);
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
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
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
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(queueBody(92, gh)).toBe('');
  });
});
