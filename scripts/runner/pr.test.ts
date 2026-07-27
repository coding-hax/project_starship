import { describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import {
  prCiState,
  prFailureSummary,
  prForIssue,
  prIsBehind,
  prIsDirty,
  prMergeState,
  prSquashMerge,
  reopenFalselyClosedIssues,
} from './pr';

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

describe('prForIssue', () => {
  it('findet die PR-Nummer ueber die Branch-Konvention feat/fix/chore', () => {
    const gh = ghRouter({
      'pr list': JSON.stringify([
        { number: 55, headRefName: 'fix/201-runner-ci-watch' },
        { number: 56, headRefName: 'feat/999-irgendwas' },
      ]),
    });
    expect(prForIssue(201, gh)).toBe('55');
  });

  it('liefert leer, wenn kein Branch passt', () => {
    const gh = ghRouter({ 'pr list': '[]' });
    expect(prForIssue(201, gh)).toBe('');
  });

  it('liefert leer statt zu werfen, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prForIssue(201, gh)).toBe('');
  });
});

describe('prMergeState / prIsBehind', () => {
  it('parst headRefName + mergeStateStatus', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }) });
    expect(prMergeState('55', gh)).toEqual({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' });
    expect(prIsBehind('55', gh)).toBe(true);
  });

  it('CLEAN ist nicht behind', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }) });
    expect(prIsBehind('55', gh)).toBe(false);
  });

  it('liefert null, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prMergeState('55', gh)).toBeNull();
    expect(prIsBehind('55', gh)).toBe(false);
  });
});

describe('prCiState', () => {
  it('keine Checks -> pending', () => {
    const gh = ghRouter({ 'pr checks': '[]' });
    expect(prCiState('55', gh)).toBe('pending');
  });

  it('pending hat Vorrang vor failing (#160)', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([
        { bucket: 'fail', name: 'e2e' },
        { bucket: 'pending', name: 'quality' },
      ]),
    });
    expect(prCiState('55', gh)).toBe('pending');
  });

  it('failing, wenn nichts mehr pending ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([
        { bucket: 'pass', name: 'quality' },
        { bucket: 'fail', name: 'e2e' },
      ]),
    });
    expect(prCiState('55', gh)).toBe('failing');
  });

  it('behind erst geprueft, wenn alles gruen/nicht-pending ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }),
    });
    expect(prCiState('55', gh)).toBe('behind');
  });

  it('success, wenn alles gruen und nicht behind ist', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }),
    });
    expect(prCiState('55', gh)).toBe('success');
  });

  // #217 AC1: der eigentliche Fund des Tickets -- ein DIRTY-PR mit gruenen
  // Checks fiel vorher auf 'success' durch, weil GitHub fuer ihn nie mehr
  // 'BEHIND' meldet. Der Runner hat ihn dann Takt fuer Takt vergeblich zu
  // mergen versucht.
  it('conflict statt success, wenn der PR DIRTY ist und alle Checks gruen sind (#217)', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', gh)).toBe('conflict');
  });

  it('pending und failing haben weiterhin Vorrang vor conflict (#217)', () => {
    const pending = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'pending', name: 'e2e' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', pending)).toBe('pending');

    const failing = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'fail', name: 'e2e' }]),
      'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }),
    });
    expect(prCiState('55', failing)).toBe('failing');
  });
});

describe('prIsDirty', () => {
  it('DIRTY ist ein Konflikt', () => {
    const gh = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'DIRTY' }) });
    expect(prIsDirty('55', gh)).toBe(true);
  });

  it('BEHIND und CLEAN sind kein Konflikt', () => {
    const behind = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }) });
    expect(prIsDirty('55', behind)).toBe(false);
    const clean = ghRouter({ 'pr view': JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'CLEAN' }) });
    expect(prIsDirty('55', clean)).toBe(false);
  });

  it('kein Konflikt, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(prIsDirty('55', gh)).toBe(false);
  });
});

describe('prSquashMerge', () => {
  it('uebergibt den PR-Titel als --subject und leeres --body', () => {
    const gh = ghRouter({ 'pr view': 'fix(runner): needs-input — Closes #163' });
    prSquashMerge('55', gh);
    expect(gh.run).toHaveBeenCalledWith([
      'pr',
      'merge',
      '--squash',
      '--auto',
      '--delete-branch',
      '--subject',
      'fix(runner): needs-input — Closes #163',
      '--body',
      '',
      '55',
    ]);
  });

  it('faellt ohne ermittelbaren Titel auf den blanken Merge-Aufruf zurueck', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'view') return '';
        return '';
      }),
    };
    prSquashMerge('56', gh);
    expect(gh.run).toHaveBeenCalledWith(['pr', 'merge', '--squash', '--auto', '--delete-branch', '56']);
  });

  // #217 AC4: der Rueckgabewert ist die Grundlage dafuer, ob 'parked' bzw.
  // 'needs-input' ueberhaupt entfernt werden duerfen.
  it('wirft nicht weiter, aber meldet false, wenn der Merge-Aufruf selbst scheitert (#217)', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'view') return 'title';
        throw new Error('merge failed');
      }),
    };
    let result: boolean | undefined;
    expect(() => {
      result = prSquashMerge('57', gh);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('meldet true, wenn der Merge-Aufruf durchgeht (#217)', () => {
    const gh = ghRouter({ 'pr view': 'fix(runner): x — Closes #1', 'pr merge': '' });
    expect(prSquashMerge('58', gh)).toBe(true);
  });
});

describe('reopenFalselyClosedIssues', () => {
  it('oeffnet ein faelschlich geschlossenes Ticket wieder und kommentiert den Grund', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([
            { number: 166, title: 'fix(runner): needs-input bei geschützten Pfaden — Closes #163' },
            { number: 170, title: 'feat(weather): Feinschliff — Closes #155' },
          ]);
        }
        if (key.startsWith('issue view 163')) return 'CLOSED';
        if (key.startsWith('issue view 155')) return 'OPEN';
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).toHaveBeenCalledWith(['issue', 'reopen', '163']);
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '155']);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'comment', '163', '--body', expect.stringContaining('#166')]);
  });

  it('laesst ein bereits offenes Ticket unangetastet', () => {
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr list')) {
          return JSON.stringify([{ number: 166, title: 'fix: x — Closes #163' }]);
        }
        if (key.startsWith('issue view')) return 'OPEN';
        return '';
      }),
    };

    reopenFalselyClosedIssues(gh);

    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'reopen', '163']);
  });

  it('ueberlebt eine leere/kaputte PR-Liste', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    expect(() => reopenFalselyClosedIssues(gh)).not.toThrow();
  });
});

describe('prFailureSummary', () => {
  // #283: Bis heute nahm diese Zusammenfassung 'protected-paths' bewusst aus --
  // der Check war eine Genehmigungs-Schranke, kein Fund, den ein Agent haette
  // beheben koennen. Den Job gibt es nicht mehr, also gilt wieder die einfache
  // Regel: jeder rote Check ist ein Fund, gedeckelt auf die ersten drei.
  it('nennt Job, Kurzbeschreibung und Log-Ausschnitt, hoechstens die ersten drei roten Checks', () => {
    const checks = [
      { bucket: 'fail', name: 'e2e', description: '2 tests failed in shard 2', link: 'https://x/actions/runs/999999/job/111' },
      { bucket: 'fail', name: 'lint', description: 'eslint rot' },
      { bucket: 'fail', name: 'typecheck', description: 'tsc rot' },
      { bucket: 'cancel', name: 'e2e-2', description: 'abgebrochen' },
    ];
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        const key = args.join(' ');
        if (key.startsWith('pr checks')) return JSON.stringify(checks);
        if (key.startsWith('run view 999999')) return 'log line 1\nlog line 2';
        return '';
      }),
    };

    const summary = prFailureSummary('55', gh);

    expect(summary).toContain('### e2e');
    expect(summary).toContain('2 tests failed in shard 2');
    expect(summary).toContain('log line 1');
    expect(summary).toContain('### lint');
    expect(summary).toContain('### typecheck');
    // Der vierte faellt raus -- sonst waechst der Auftrag mit jedem Shard.
    expect(summary).not.toContain('e2e-2');
  });

  it('nimmt keinen Check mehr aus -- auch ein Check namens protected-paths zaehlt', () => {
    const gh = ghRouter({
      'pr checks': JSON.stringify([{ bucket: 'fail', name: 'protected-paths', description: 'irgendwas' }]),
    });
    expect(prFailureSummary('55', gh)).toContain('### protected-paths');
  });

  it('leer, wenn nichts rot ist', () => {
    const gh = ghRouter({ 'pr checks': JSON.stringify([{ bucket: 'pass', name: 'quality' }]) });
    expect(prFailureSummary('55', gh)).toBe('');
  });
});
