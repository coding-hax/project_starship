import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createStateAdapter, type StateAdapter } from './state';
import { conflictSummary, watchParkedIssues, watchReaction, watchRunningIssue, type WatchState } from './watch';

const ALL_STATES: WatchState[] = [
  'pending',
  'success',
  'failing-protected',
  'failing-fix',
  'behind-caught-up',
  'behind-conflict',
  'behind-retry',
];

describe('watchReaction (AC1/AC2: eine Übergangstabelle, keine Lücke)', () => {
  it('liefert für JEDEN WatchState UND parked:true/false eine definierte Reaktion', () => {
    for (const state of ALL_STATES) {
      for (const parked of [true, false]) {
        const reaction = watchReaction({ state, parked, retryEscalated: false });
        expect(reaction).toBeDefined();
        expect(reaction.kind).not.toBeUndefined();
      }
    }
  });

  it('pending: laufend wartet grün, geparkt bleibt still', () => {
    expect(watchReaction({ state: 'pending', parked: false })).toEqual({ kind: 'wait', severity: 'green' });
    expect(watchReaction({ state: 'pending', parked: true })).toEqual({ kind: 'noop' });
  });

  it('success: merge, unabhängig von parked', () => {
    expect(watchReaction({ state: 'success', parked: false })).toEqual({ kind: 'merge' });
    expect(watchReaction({ state: 'success', parked: true })).toEqual({ kind: 'merge' });
  });

  it('failing-protected: laufend setzt needs-input, geparkt bleibt die stille Genehmigungs-Schranke', () => {
    expect(watchReaction({ state: 'failing-protected', parked: false })).toEqual({ kind: 'add-needs-input' });
    expect(watchReaction({ state: 'failing-protected', parked: true })).toEqual({ kind: 'noop' });
  });

  it('failing-fix: laufend startet Fix-Agent, geparkt wird Entparken-Kandidat', () => {
    expect(watchReaction({ state: 'failing-fix', parked: false })).toEqual({ kind: 'build-fix' });
    expect(watchReaction({ state: 'failing-fix', parked: true })).toEqual({ kind: 'promote-candidate' });
  });

  it('behind-caught-up: laufend grün, geparkt still', () => {
    expect(watchReaction({ state: 'behind-caught-up', parked: false })).toEqual({ kind: 'wait', severity: 'green' });
    expect(watchReaction({ state: 'behind-caught-up', parked: true })).toEqual({ kind: 'noop' });
  });

  it('behind-conflict: laufend Fix-Agent, geparkt Entparken-Kandidat', () => {
    expect(watchReaction({ state: 'behind-conflict', parked: false })).toEqual({ kind: 'build-fix' });
    expect(watchReaction({ state: 'behind-conflict', parked: true })).toEqual({ kind: 'promote-candidate' });
  });

  it('behind-retry: geparkt IMMER still, laufend abhängig von retryEscalated', () => {
    expect(watchReaction({ state: 'behind-retry', parked: true })).toEqual({ kind: 'noop' });
    expect(watchReaction({ state: 'behind-retry', parked: true, retryEscalated: true })).toEqual({ kind: 'noop' });
    expect(watchReaction({ state: 'behind-retry', parked: false, retryEscalated: false })).toEqual({
      kind: 'wait',
      severity: 'green',
    });
    expect(watchReaction({ state: 'behind-retry', parked: false, retryEscalated: true })).toEqual({
      kind: 'wait',
      severity: 'yellow',
    });
  });
});

describe('conflictSummary', () => {
  it('nennt PR, Ticket und die Konfliktdateien', () => {
    const text = conflictSummary(702, '402', ['src/a.ts', 'src/b.ts']);
    expect(text).toContain('Merge-Konflikt');
    expect(text).toContain('#402');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });

  it('fällt ohne Dateien auf "unbekannt" zurück', () => {
    expect(conflictSummary(1, '2', [])).toContain('unbekannt');
  });
});

// --- Test-Doubles fuer watchRunningIssue/watchParkedIssues -------------------
// Mehrere PRs gleichzeitig ansprechbar (checks-$pr/mergestate-$pr), analog zu
// den Bash-Stubs in ci-watch.test.sh/parked-ci-watch.test.sh.
interface Check {
  bucket: string;
  name: string;
  description?: string;
  link?: string;
}

interface GhFixture {
  checks?: Record<string, Check[]>;
  mergeState?: Record<string, { headRefName: string; mergeStateStatus: string }>;
  prList?: { number: number; headRefName: string }[];
}

function ghFake(fx: GhFixture = {}): GhAdapter {
  return {
    run: vi.fn((args: string[]) => {
      const [a, b, c] = args;
      if (a === 'pr' && b === 'checks') return JSON.stringify(fx.checks?.[c] ?? []);
      if (a === 'pr' && b === 'view') {
        const ms = fx.mergeState?.[c];
        return JSON.stringify(ms ?? { headRefName: 'unknown', mergeStateStatus: 'CLEAN' });
      }
      if (a === 'pr' && b === 'list') return JSON.stringify(fx.prList ?? []);
      if (a === 'run' && b === 'view') return 'log line 1\nlog line 2';
      return '';
    }),
  };
}

interface GitFixture {
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
          return 'main';
        case 'fetch':
          if (fx.failFetch) throw new Error('fetch failed');
          return '';
        case 'checkout':
          if (args[1] === '-B' && fx.failCheckout) throw new Error('checkout failed');
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

describe('watchRunningIssue (Parität zu scripts/tests/ci-watch.test.sh)', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-watch-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('T1: CI läuft noch (pending) -> kein Merge, kein Fix', () => {
    const gh = ghFake({ checks: { '501': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pending', name: 'e2e' }] } });
    const result = watchRunningIssue(301, '501', { gh, git: gitFake(), state });
    expect(result).toEqual({ kind: 'pending' });
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '501']);
  });

  it('T2: CI grün -> ready + Squash-Merge', () => {
    const gh = ghFake({
      checks: { '502': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '502': { headRefName: 'fix/302-x', mergeStateStatus: 'CLEAN' } },
    });
    const result = watchRunningIssue(302, '502', { gh, git: gitFake(), state });
    expect(result).toEqual({ kind: 'merged' });
    expect(gh.run).toHaveBeenCalledWith(['pr', 'ready', '502']);
  });

  it('T3: CI rot (nicht nur protected-paths) -> Fix-Agent mit Summary', () => {
    const gh = ghFake({
      checks: {
        '503': [
          { bucket: 'pass', name: 'quality' },
          { bucket: 'fail', name: 'e2e', description: '2 tests failed in shard 2', link: 'https://x/actions/runs/999999/job/111' },
        ],
      },
    });
    const result = watchRunningIssue(303, '503', { gh, git: gitFake(), state });
    expect(result.kind).toBe('build-fix');
    if (result.kind === 'build-fix') {
      expect(result.summary).toContain('e2e');
      expect(result.summary).toContain('2 tests failed in shard 2');
    }
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '503']);
  });

  it('T4: CI rot NUR bei protected-paths -> needs-input, kein Fix-Agent', () => {
    const gh = ghFake({
      checks: { '504': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'protected-paths', description: 'Approval missing' }] },
    });
    const result = watchRunningIssue(304, '504', { gh, git: gitFake(), state });
    expect(result).toEqual({ kind: 'needs-input-protected' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '304', '--add-label', 'needs-input']);
  });

  it('T7: hinter main, Checks grün, kein Konflikt -> nachgezogen, kein Merge', () => {
    const gh = ghFake({
      checks: { '701': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '701': { headRefName: 'fix/401-x', mergeStateStatus: 'BEHIND' } },
    });
    const result = watchRunningIssue(401, '701', { gh, git: gitFake(), state });
    expect(result).toEqual({ kind: 'caught-up' });
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '701']);
  });

  it('T8: Nachziehen scheitert an echtem Merge-Konflikt -> Fix-Agent mit Konfliktdateien', () => {
    const gh = ghFake({
      checks: { '702': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '702': { headRefName: 'fix/402-x', mergeStateStatus: 'BEHIND' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    const result = watchRunningIssue(402, '702', { gh, git, state });
    expect(result.kind).toBe('build-fix');
    if (result.kind === 'build-fix') {
      expect(result.summary).toContain('Merge-Konflikt');
      expect(result.summary).toContain('src/a.ts');
      expect(result.summary).toContain('src/b.ts');
    }
  });

  it('T15/T16: unsauberer Arbeitsbaum -> retry grün, erst nach 3 Runden eskaliert gelb', () => {
    const gh = ghFake({
      checks: { '740': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '740': { headRefName: 'fix/440-x', mergeStateStatus: 'BEHIND' } },
    });
    const git = gitFake({ dirty: ['some/file.ts'] });
    const r1 = watchRunningIssue(440, '740', { gh, git, state });
    const r2 = watchRunningIssue(440, '740', { gh, git, state });
    const r3 = watchRunningIssue(440, '740', { gh, git, state });
    expect(r1).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: false });
    expect(r2).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: false });
    expect(r3).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: true });
  });

  it('T17/T18/T19: fetch/checkout/push-Fehlschlag sind unterscheidbare Gründe', () => {
    const gh = (pr: string) =>
      ghFake({
        checks: { [pr]: [{ bucket: 'pass', name: 'quality' }] },
        mergeState: { [pr]: { headRefName: 'fix/x', mergeStateStatus: 'BEHIND' } },
      });
    const fetchResult = watchRunningIssue(442, '742', { gh: gh('742'), git: gitFake({ failFetch: true }), state });
    const checkoutResult = watchRunningIssue(443, '743', { gh: gh('743'), git: gitFake({ failCheckout: true }), state });
    const pushResult = watchRunningIssue(444, '744', { gh: gh('744'), git: gitFake({ failPush: true }), state });
    expect(fetchResult.kind === 'retry' && fetchResult.reason).toContain('fetch fehlgeschlagen');
    expect(checkoutResult.kind === 'retry' && checkoutResult.reason).toBe('checkout fehlgeschlagen');
    expect(pushResult.kind === 'retry' && pushResult.reason).toBe('push fehlgeschlagen');
  });
});

describe('watchParkedIssues (Parität zu scripts/tests/parked-ci-watch.test.sh)', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-watch-parked-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function issue(n: number, createdAt = '2024-01-01T00:00:00Z', hasNeedsInput = false) {
    return { number: n, createdAt, hasNeedsInput };
  }

  it('T1: PR komplett grün -> freigegeben (merge + Labels entfernt), kein Fix-Agent', () => {
    const gh = ghFake({
      prList: [{ number: 601, headRefName: 'fix/401-x' }],
      checks: { '601': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
    });
    const outcome = watchParkedIssues([issue(401, '2024-01-01T00:00:00Z', true)], true, { gh, git: gitFake(), state });
    expect(outcome.released).toEqual([401]);
    expect(outcome.promoted).toBeNull();
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '401', '--remove-label', 'parked', '--remove-label', 'needs-input']);
  });

  it('T2/T3: PR pending/rot (nicht entparkbar) -> bleibt unverändert geparkt', () => {
    const ghPending = ghFake({
      prList: [{ number: 602, headRefName: 'fix/402-x' }],
      checks: { '602': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pending', name: 'e2e' }] },
    });
    const outPending = watchParkedIssues([issue(402)], true, { gh: ghPending, git: gitFake(), state });
    expect(outPending).toEqual({ promoted: null, released: [] });
  });

  it('T5: mehrere geparkte Tickets -- eins grün (freigegeben), eins pending (bleibt)', () => {
    const gh = ghFake({
      prList: [
        { number: 701, headRefName: 'fix/501-x' },
        { number: 702, headRefName: 'fix/502-x' },
      ],
      checks: {
        '701': [{ bucket: 'pass', name: 'quality' }],
        '702': [{ bucket: 'pending', name: 'e2e' }],
      },
    });
    const outcome = watchParkedIssues([issue(501), issue(502, '2024-01-02T00:00:00Z', true)], true, {
      gh,
      git: gitFake(),
      state,
    });
    expect(outcome.released).toEqual([501]);
    expect(outcome.promoted).toBeNull();
  });

  it('T7: hinter main + echter Merge-Konflikt -> entparkt (Kandidat), Grund benannt', () => {
    const gh = ghFake({
      prList: [{ number: 720, headRefName: 'fix/420-x' }],
      checks: { '720': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '720': { headRefName: 'fix/420-x', mergeStateStatus: 'BEHIND' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts'] });
    const outcome = watchParkedIssues([issue(420)], true, { gh, git, state });
    expect(outcome.promoted).toEqual({ issue: 420, reason: 'ein Merge-Konflikt beim Nachziehen von `main`' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '420', '--remove-label', 'parked', '--add-label', 'in-progress']);
  });

  it('T8: rote Checks über protected-paths hinaus -> entparkt (Kandidat)', () => {
    const gh = ghFake({
      prList: [{ number: 721, headRefName: 'fix/421-x' }],
      checks: { '721': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: '2 tests failed' }] },
    });
    const outcome = watchParkedIssues([issue(421)], true, { gh, git: gitFake(), state });
    expect(outcome.promoted).toEqual({ issue: 421, reason: 'rote Checks (mehr als nur `protected-paths`)' });
  });

  it('T9: nur protected-paths rot bleibt die Genehmigungs-Schranke -- kein Entparken', () => {
    const gh = ghFake({
      prList: [{ number: 722, headRefName: 'fix/422-x' }],
      checks: { '722': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'protected-paths', description: 'Approval missing' }] },
    });
    const outcome = watchParkedIssues([issue(422, '2024-01-01T00:00:00Z', true)], true, { gh, git: gitFake(), state });
    expect(outcome).toEqual({ promoted: null, released: [] });
  });

  it('T10: needs-input hängt schon -- kein automatisches Entparken über die offene Frage hinweg', () => {
    const gh = ghFake({
      prList: [{ number: 723, headRefName: 'fix/423-x' }],
      checks: { '723': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: '2 tests failed' }] },
    });
    const outcome = watchParkedIssues([issue(423, '2024-01-01T00:00:00Z', true)], true, { gh, git: gitFake(), state });
    expect(outcome.promoted).toBeNull();
  });

  it('T11: WIP-Limit=1 -- ein entparkbares Ticket bleibt geparkt, solange der Bauplatz belegt ist', () => {
    const gh = ghFake({
      prList: [{ number: 825, headRefName: 'fix/425-x' }],
      checks: { '825': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: '2 tests failed' }] },
    });
    const outcome = watchParkedIssues([issue(425)], false, { gh, git: gitFake(), state });
    expect(outcome.promoted).toBeNull();
  });

  it('T12: höchstens EIN Ticket pro Runde -- das ältere (createdAt) gewinnt', () => {
    const gh = ghFake({
      prList: [
        { number: 826, headRefName: 'fix/426-x' },
        { number: 827, headRefName: 'fix/427-x' },
      ],
      checks: {
        '826': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: 'älter' }],
        '827': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: 'jünger' }],
      },
    });
    // Bewusst in "falscher" Reihenfolge übergeben -- watchParkedIssues sortiert
    // selbst nach createdAt, wie PARKED_LIST in der Bash-Vorlage.
    const outcome = watchParkedIssues(
      [issue(427, '2025-06-01T00:00:00Z'), issue(426, '2024-01-01T00:00:00Z')],
      true,
      { gh, git: gitFake(), state },
    );
    expect(outcome.promoted?.issue).toBe(426);
  });

  it('kein offener PR fürs Ticket -> wird übersprungen, kein Fehler', () => {
    const gh = ghFake({ prList: [] });
    const outcome = watchParkedIssues([issue(999)], true, { gh, git: gitFake(), state });
    expect(outcome).toEqual({ promoted: null, released: [] });
  });
});
