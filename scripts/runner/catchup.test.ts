import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createStateAdapter, type StateAdapter } from './state';
import {
  catchupExitCode,
  catchupFailEscalated,
  catchupFailReason,
  catchupFailReset,
  catchupStdout,
  prCatchUpBehind,
} from './catchup';

function gh(headRefName = 'fix/1-x'): GhAdapter {
  return { run: vi.fn().mockReturnValue(JSON.stringify({ headRefName, mergeStateStatus: 'BEHIND' })) };
}

// Simuliert git wie die Stubs in scripts/tests/ci-watch.test.sh: steuerbare
// Fehlschlaege je Unterkommando, ein aktueller Branch, optionale
// Konfliktdateien.
interface GitFixture {
  cur?: string;
  dirty?: string[];
  failFetch?: boolean;
  failCheckout?: boolean;
  failMerge?: boolean;
  failPush?: boolean;
  conflictFiles?: string[];
}

function gitFake(fx: GitFixture = {}): GitAdapter {
  return {
    run: vi.fn((args: string[]) => {
      switch (args[0]) {
        case 'status':
          return (fx.dirty ?? []).map((f) => ` M ${f}`).join('\n');
        case 'rev-parse':
          return fx.cur ?? 'main';
        case 'fetch':
          if (fx.failFetch) throw new Error('fetch failed');
          return '';
        case 'checkout':
          if (args[1] === '-B') {
            if (fx.failCheckout) throw new Error('checkout failed');
          }
          return '';
        case 'merge':
          if (args[1] === '--abort') return '';
          if (fx.failMerge) throw new Error('merge conflict');
          return '';
        case 'diff':
          return (fx.conflictFiles ?? []).join('\n');
        case 'push':
          if (fx.failPush) throw new Error('push failed');
          return '';
        default:
          return '';
      }
    }),
  };
}

describe('prCatchUpBehind', () => {
  it('zieht sauber nach und pusht (ok)', () => {
    const git = gitFake();
    const result = prCatchUpBehind('55', git, gh());
    expect(result).toEqual({ kind: 'ok' });
    expect(catchupExitCode(result)).toBe(0);
    expect(catchupStdout(result)).toBe('');
    expect(git.run).toHaveBeenCalledWith(['push', 'origin', 'HEAD:fix/1-x', '--quiet']);
    expect(git.run).toHaveBeenCalledWith(['checkout', 'main', '--quiet']);
  });

  it('unsauberer Arbeitsbaum -> dirty mit den stoerenden Pfaden (hoechstens 5)', () => {
    const git = gitFake({ dirty: ['some/file.ts', 'a', 'b', 'c', 'd', 'e'] });
    const result = prCatchUpBehind('55', git, gh());
    expect(result.kind).toBe('dirty');
    if (result.kind === 'dirty') {
      expect(result.paths).toEqual(['some/file.ts', 'a', 'b', 'c', 'd']);
    }
    expect(catchupExitCode(result)).toBe(2);
    expect(catchupStdout(result)).toBe('some/file.ts,a,b,c,d');
    // kein fetch/checkout/push bei unsauberem Baum
    expect(git.run).not.toHaveBeenCalledWith(expect.arrayContaining(['fetch']));
  });

  it('leerer Branchname (PR-Metadaten nicht lesbar) -> fetchFailed, kein git-Aufruf', () => {
    const ghEmpty: GhAdapter = { run: vi.fn().mockReturnValue('') };
    const git = gitFake();
    const result = prCatchUpBehind('55', git, ghEmpty);
    expect(result).toEqual({ kind: 'fetchFailed' });
    expect(catchupExitCode(result)).toBe(3);
    expect(git.run).not.toHaveBeenCalled();
  });

  it('git fetch scheitert -> fetchFailed', () => {
    const git = gitFake({ failFetch: true });
    const result = prCatchUpBehind('55', git, gh());
    expect(result).toEqual({ kind: 'fetchFailed' });
    expect(catchupExitCode(result)).toBe(3);
  });

  it('git checkout -B scheitert -> checkoutFailed', () => {
    const git = gitFake({ failCheckout: true });
    const result = prCatchUpBehind('55', git, gh());
    expect(result).toEqual({ kind: 'checkoutFailed' });
    expect(catchupExitCode(result)).toBe(4);
  });

  it('git push scheitert -> pushFailed, kehrt zum vorherigen Branch zurueck', () => {
    const git = gitFake({ failPush: true, cur: 'feat/9-x' });
    const result = prCatchUpBehind('55', git, gh());
    expect(result).toEqual({ kind: 'pushFailed' });
    expect(catchupExitCode(result)).toBe(5);
    expect(git.run).toHaveBeenCalledWith(['checkout', 'feat/9-x', '--quiet']);
  });

  it('echter Merge-Konflikt -> conflict mit Konfliktdateien, Merge wird abgebrochen', () => {
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    const result = prCatchUpBehind('55', git, gh());
    expect(result).toEqual({ kind: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
    expect(catchupExitCode(result)).toBe(1);
    expect(catchupStdout(result)).toBe('src/a.ts,src/b.ts');
    expect(git.run).toHaveBeenCalledWith(['merge', '--abort']);
    expect(git.run).toHaveBeenCalledWith(['checkout', 'main', '--quiet']);
  });

  it('HEAD (detached) als aktueller Branch faellt auf main zurueck', () => {
    const git = gitFake({ cur: 'HEAD', failPush: true });
    const result = prCatchUpBehind('55', git, gh());
    expect(result.kind).toBe('pushFailed');
    expect(git.run).toHaveBeenCalledWith(['checkout', 'main', '--quiet']);
  });
});

describe('catchupFailReason', () => {
  it('kennt alle vier Nicht-Konflikt-Ursachen und einen Default', () => {
    expect(catchupFailReason(2)).toBe('unsauberer Arbeitsbaum');
    expect(catchupFailReason(3)).toContain('fetch fehlgeschlagen');
    expect(catchupFailReason(4)).toBe('checkout fehlgeschlagen');
    expect(catchupFailReason(5)).toBe('push fehlgeschlagen');
    expect(catchupFailReason(99)).toBe('unbekannter Fehler');
  });
});

describe('catchupFailEscalated / catchupFailReset', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-catchup-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('eskaliert erst ab der dritten Runde in Folge mit derselben Ursache', () => {
    expect(catchupFailEscalated(440, 'unsauberer Arbeitsbaum', state)).toBe(false);
    expect(catchupFailEscalated(440, 'unsauberer Arbeitsbaum', state)).toBe(false);
    expect(catchupFailEscalated(440, 'unsauberer Arbeitsbaum', state)).toBe(true);
  });

  it('eine wechselnde Ursache setzt den Zaehler auf 1 zurueck', () => {
    expect(catchupFailEscalated(441, 'unsauberer Arbeitsbaum', state)).toBe(false);
    expect(catchupFailEscalated(441, 'unsauberer Arbeitsbaum', state)).toBe(false);
    expect(catchupFailEscalated(441, 'push fehlgeschlagen', state)).toBe(false);
    expect(state.read('catchup-fail-441')).toBe('push fehlgeschlagen\n1\n');
  });

  it('catchupFailReset raeumt die Zaehldatei weg', () => {
    catchupFailEscalated(442, 'unsauberer Arbeitsbaum', state);
    expect(state.exists('catchup-fail-442')).toBe(true);
    catchupFailReset(442, state);
    expect(state.exists('catchup-fail-442')).toBe(false);
  });
});
