import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createFixedClock, type Clock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import {
  conflictSummary,
  dirtySummary,
  watchWaitingIssues,
  watchReaction,
  watchRunningIssue,
  PENDING_STALL_MINUTES,
  type WatchState,
} from './watch';

const FIXED_CLOCK = createFixedClock(new Date('2026-07-28T10:00:00Z'));

const ALL_STATES: WatchState[] = [
  'pending',
  'success',
  'failing-fix',
  'behind-caught-up',
  'behind-conflict',
  'behind-retry',
  'dirty-conflict',
];

describe('watchReaction (AC1/AC2: eine Übergangstabelle, keine Lücke)', () => {
  it('liefert für JEDEN WatchState UND waiting:true/false eine definierte Reaktion', () => {
    for (const state of ALL_STATES) {
      for (const waiting of [true, false]) {
        const reaction = watchReaction({ state, waiting, retryEscalated: false });
        expect(reaction).toBeDefined();
        expect(reaction.kind).not.toBeUndefined();
      }
    }
  });

  it('pending: laufend wartet grün, wartend bleibt still', () => {
    expect(watchReaction({ state: 'pending', waiting: false })).toEqual({ kind: 'wait', severity: 'green' });
    expect(watchReaction({ state: 'pending', waiting: true })).toEqual({ kind: 'noop' });
  });

  // #324: über der Schwelle kippt NUR das laufende Ticket auf Gelb -- ein
  // wartendes bleibt bei 'pending' ohnehin still, unabhängig von der Dauer.
  it('pending: über der Schwelle kippt laufend auf gelb, wartend bleibt still', () => {
    expect(watchReaction({ state: 'pending', waiting: false, pendingEscalated: false })).toEqual({
      kind: 'wait',
      severity: 'green',
    });
    expect(watchReaction({ state: 'pending', waiting: false, pendingEscalated: true })).toEqual({
      kind: 'wait',
      severity: 'yellow',
    });
    expect(watchReaction({ state: 'pending', waiting: true, pendingEscalated: true })).toEqual({ kind: 'noop' });
  });

  it('success: merge, unabhängig vom Warten', () => {
    expect(watchReaction({ state: 'success', waiting: false })).toEqual({ kind: 'merge' });
    expect(watchReaction({ state: 'success', waiting: true })).toEqual({ kind: 'merge' });
  });

  it('failing-fix: laufend startet Fix-Agent, wartend bleibt still (#272: kein Entparken mehr)', () => {
    expect(watchReaction({ state: 'failing-fix', waiting: false })).toEqual({ kind: 'build-fix' });
    expect(watchReaction({ state: 'failing-fix', waiting: true })).toEqual({ kind: 'noop' });
  });

  it('behind-caught-up: laufend grün, wartend still', () => {
    expect(watchReaction({ state: 'behind-caught-up', waiting: false })).toEqual({ kind: 'wait', severity: 'green' });
    expect(watchReaction({ state: 'behind-caught-up', waiting: true })).toEqual({ kind: 'noop' });
  });

  it('behind-conflict: laufend Fix-Agent, wartend still', () => {
    expect(watchReaction({ state: 'behind-conflict', waiting: false })).toEqual({ kind: 'build-fix' });
    expect(watchReaction({ state: 'behind-conflict', waiting: true })).toEqual({ kind: 'noop' });
  });

  it('dirty-conflict: laufend Fix-Agent, wartend still (#217 AC2/AC3)', () => {
    expect(watchReaction({ state: 'dirty-conflict', waiting: false })).toEqual({ kind: 'build-fix' });
    expect(watchReaction({ state: 'dirty-conflict', waiting: true })).toEqual({ kind: 'noop' });
  });

  it('behind-retry: wartend IMMER still, laufend abhängig von retryEscalated', () => {
    expect(watchReaction({ state: 'behind-retry', waiting: true })).toEqual({ kind: 'noop' });
    expect(watchReaction({ state: 'behind-retry', waiting: true, retryEscalated: true })).toEqual({ kind: 'noop' });
    expect(watchReaction({ state: 'behind-retry', waiting: false, retryEscalated: false })).toEqual({
      kind: 'wait',
      severity: 'green',
    });
    expect(watchReaction({ state: 'behind-retry', waiting: false, retryEscalated: true })).toEqual({
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

describe('dirtySummary (#217)', () => {
  it('nennt DIRTY als Ursache, PR, Ticket und die Konfliktdateien', () => {
    const text = dirtySummary(450, '750', ['src/a.ts', 'src/b.ts']);
    expect(text).toContain('Merge-Konflikt');
    expect(text).toContain('DIRTY');
    expect(text).toContain('#450');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });

  // AC2: eine leere Dateiliste darf nicht als "keine Konfliktdateien"
  // durchgehen -- der Auftrag muss sagen, WARUM sie fehlt.
  it('nennt den Grund, wenn die lokale Ermittlung an Infrastruktur scheitert', () => {
    const text = dirtySummary(452, '752', [], 'git fetch ist fehlgeschlagen');
    expect(text).toContain('unbekannt');
    expect(text).toContain('git fetch ist fehlgeschlagen');
  });

  it('fällt ohne Dateien und ohne Grund auf "unbekannt" zurück', () => {
    expect(dirtySummary(1, '2', [])).toContain('unbekannt');
  });
});

// --- Test-Doubles fuer watchRunningIssue/watchWaitingIssues -------------------
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
    const result = watchRunningIssue(301, '501', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result).toEqual({ kind: 'pending', escalated: false, minutes: 0 });
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '501']);
  });

  // #324: frisches 'pending' bleibt grün, ab der Schwelle kippt derselbe
  // Check auf gelb -- mit Ticketnummer und Dauer im Text (round.test.ts prüft
  // den Statustext, hier nur die reine Entscheidung + Minutenzahl).
  it('#324 AC1-3: pending unter der Schwelle bleibt grün, ab PENDING_STALL_MINUTES kippt gelb', () => {
    let nowMs = Date.parse('2026-07-28T10:00:00Z');
    const clock: Clock = { now: () => new Date(nowMs) };
    const gh = ghFake({ checks: { '900': [{ bucket: 'pending', name: 'e2e' }] } });

    const first = watchRunningIssue(900, '900', { gh, git: gitFake(), state, clock });
    expect(first).toEqual({ kind: 'pending', escalated: false, minutes: 0 });

    nowMs += (PENDING_STALL_MINUTES - 1) * 60_000;
    const stillGreen = watchRunningIssue(900, '900', { gh, git: gitFake(), state, clock });
    expect(stillGreen).toEqual({ kind: 'pending', escalated: false, minutes: PENDING_STALL_MINUTES - 1 });

    nowMs += 1 * 60_000;
    const escalated = watchRunningIssue(900, '900', { gh, git: gitFake(), state, clock });
    expect(escalated).toEqual({ kind: 'pending', escalated: true, minutes: PENDING_STALL_MINUTES });
  });

  // #324 AC4: sobald der PR nicht mehr pending ist (hier: rot), verschwindet
  // der Zeitstempel -- ein späterer 'pending'-Lauf beginnt neu bei 0.
  it('#324 AC4: verschwindet der PR aus pending, beginnt ein späterer pending-Lauf neu zu zählen', () => {
    let nowMs = Date.parse('2026-07-28T10:00:00Z');
    const clock: Clock = { now: () => new Date(nowMs) };
    const ghPending = ghFake({ checks: { '901': [{ bucket: 'pending', name: 'e2e' }] } });
    watchRunningIssue(901, '901', { gh: ghPending, git: gitFake(), state, clock });

    nowMs += (PENDING_STALL_MINUTES + 5) * 60_000;
    const ghFailing = ghFake({
      checks: { '901': [{ bucket: 'fail', name: 'e2e', description: 'kaputt' }] },
    });
    watchRunningIssue(901, '901', { gh: ghFailing, git: gitFake(), state, clock });

    nowMs += 60_000;
    const ghPendingAgain = ghFake({ checks: { '901': [{ bucket: 'pending', name: 'e2e' }] } });
    const result = watchRunningIssue(901, '901', { gh: ghPendingAgain, git: gitFake(), state, clock });
    expect(result).toEqual({ kind: 'pending', escalated: false, minutes: 0 });
  });

  it('T2: CI grün -> ready + Squash-Merge', () => {
    const gh = ghFake({
      checks: { '502': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '502': { headRefName: 'fix/302-x', mergeStateStatus: 'CLEAN' } },
    });
    const result = watchRunningIssue(302, '502', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
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
    const result = watchRunningIssue(303, '503', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result.kind).toBe('build-fix');
    if (result.kind === 'build-fix') {
      expect(result.summary).toContain('e2e');
      expect(result.summary).toContain('2 tests failed in shard 2');
    }
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '503']);
  });

  // #283: Hier stand T4 -- "CI rot NUR bei protected-paths -> needs-answer,
  // kein Fix-Agent". Den Check gibt es nicht mehr, also auch den Zustand
  // nicht; ein roter Check ist ab jetzt IMMER ein Fund fuer den Fix-Agenten.
  // Genau das prueft der Fall daneben (T3).

  // #283: 'protected-paths' war der einzige Check-Name, den die Wache
  // gesondert behandelte. Der Job ist weg -- ein Check dieses Namens ist ab
  // jetzt ein Fund wie jeder andere. Das prueft der Ersatz fuer das
  // entfallene T4.
  it('#283: ein roter Check namens protected-paths ist ein Fund wie jeder andere', () => {
    const gh = ghFake({
      checks: { '504': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'protected-paths', description: 'irgendwas' }] },
    });
    const result = watchRunningIssue(304, '504', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result.kind).toBe('build-fix');
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'edit', '304', '--add-label', 'needs-answer']);
  });

  it('T7: hinter main, Checks grün, kein Konflikt -> nachgezogen, kein Merge', () => {
    const gh = ghFake({
      checks: { '701': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '701': { headRefName: 'fix/401-x', mergeStateStatus: 'BEHIND' } },
    });
    const result = watchRunningIssue(401, '701', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result).toEqual({ kind: 'caught-up' });
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '701']);
  });

  it('T8: Nachziehen scheitert an echtem Merge-Konflikt -> Fix-Agent mit Konfliktdateien', () => {
    const gh = ghFake({
      checks: { '702': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '702': { headRefName: 'fix/402-x', mergeStateStatus: 'BEHIND' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    const result = watchRunningIssue(402, '702', { gh, git, state, clock: FIXED_CLOCK });
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
    const r1 = watchRunningIssue(440, '740', { gh, git, state, clock: FIXED_CLOCK });
    const r2 = watchRunningIssue(440, '740', { gh, git, state, clock: FIXED_CLOCK });
    const r3 = watchRunningIssue(440, '740', { gh, git, state, clock: FIXED_CLOCK });
    expect(r1).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: false });
    expect(r2).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: false });
    expect(r3).toEqual({ kind: 'retry', reason: 'unsauberer Arbeitsbaum', paths: ['some/file.ts'], escalated: true });
  });

  // --- #217: DIRTY-PR (mergeStateStatus), laufendes Ticket ------------------
  it('T21 (#217 AC1/AC6): DIRTY + alle Checks grün -> KEIN ready, kein Merge', () => {
    const gh = ghFake({
      checks: { '750': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '750': { headRefName: 'fix/450-x', mergeStateStatus: 'DIRTY' } },
    });
    const result = watchRunningIssue(450, '750', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result.kind).not.toBe('merged');
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '750']);
  });

  it('T22 (#217 AC1/AC2): DIRTY + echter Konflikt -> Fix-Agent mit Konfliktdateien', () => {
    const gh = ghFake({
      checks: { '751': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '751': { headRefName: 'fix/451-x', mergeStateStatus: 'DIRTY' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    const result = watchRunningIssue(451, '751', { gh, git, state, clock: FIXED_CLOCK });
    expect(result.kind).toBe('build-fix');
    if (result.kind === 'build-fix') {
      expect(result.summary).toContain('DIRTY');
      expect(result.summary).toContain('src/a.ts');
      expect(result.summary).toContain('src/b.ts');
    }
    expect(gh.run).not.toHaveBeenCalledWith(['pr', 'ready', '751']);
  });

  // AC2: der entscheidende Unterschied zu 'behind' (T17) -- dort wartet der
  // Takt bei einem fetch-Fehlschlag still weiter, hier NICHT.
  it('T23 (#217 AC2): DIRTY + gescheiterte Dateiermittlung -> Fix-Agent trotzdem, Liste "unbekannt"', () => {
    const gh = ghFake({
      checks: { '752': [{ bucket: 'pass', name: 'quality' }] },
      mergeState: { '752': { headRefName: 'fix/452-x', mergeStateStatus: 'DIRTY' } },
    });
    const result = watchRunningIssue(452, '752', { gh, git: gitFake({ failFetch: true }), state, clock: FIXED_CLOCK });
    expect(result.kind).toBe('build-fix');
    if (result.kind === 'build-fix') expect(result.summary).toContain('unbekannt');
  });

  // Gegenprobe: meldet GitHub DIRTY, geht der lokale Merge aber doch durch
  // (GitHubs Berechnung war veraltet), wird ganz normal nachgezogen.
  it('#217: DIRTY, aber lokaler Merge klappt -> nachgezogen statt Fix-Agent', () => {
    const gh = ghFake({
      checks: { '753': [{ bucket: 'pass', name: 'quality' }] },
      mergeState: { '753': { headRefName: 'fix/453-x', mergeStateStatus: 'DIRTY' } },
    });
    const result = watchRunningIssue(453, '753', { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(result).toEqual({ kind: 'caught-up' });
  });

  it('T17/T18/T19: fetch/checkout/push-Fehlschlag sind unterscheidbare Gründe', () => {
    const gh = (pr: string) =>
      ghFake({
        checks: { [pr]: [{ bucket: 'pass', name: 'quality' }] },
        mergeState: { [pr]: { headRefName: 'fix/x', mergeStateStatus: 'BEHIND' } },
      });
    const fetchResult = watchRunningIssue(442, '742', { gh: gh('742'), git: gitFake({ failFetch: true }), state, clock: FIXED_CLOCK });
    const checkoutResult = watchRunningIssue(443, '743', { gh: gh('743'), git: gitFake({ failCheckout: true }), state, clock: FIXED_CLOCK });
    const pushResult = watchRunningIssue(444, '744', { gh: gh('744'), git: gitFake({ failPush: true }), state, clock: FIXED_CLOCK });
    expect(fetchResult.kind === 'retry' && fetchResult.reason).toContain('fetch fehlgeschlagen');
    expect(checkoutResult.kind === 'retry' && checkoutResult.reason).toBe('checkout fehlgeschlagen');
    expect(pushResult.kind === 'retry' && pushResult.reason).toBe('push fehlgeschlagen');
  });
});

// #272: hiess bis S2b `watchParkedIssues`. Ein wartendes Ticket wird nicht
// mehr entparkt -- es behaelt 'in-progress' und wartet auf eine Antwort, nicht
// auf einen freien Bauplatz. Die frueheren "wird Entparken-Kandidat"-Faelle
// pruefen deshalb jetzt, dass GENAU NICHTS passiert; das ist die Zusicherung,
// auf die es ankommt (kein Lauf hinter dem Ruecken des Menschen).
describe('watchWaitingIssues (Parität zu scripts/tests/parked-ci-watch.test.sh)', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-watch-waiting-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function issue(n: number, createdAt = '2024-01-01T00:00:00Z') {
    return { number: n, createdAt };
  }

  it('T1: PR komplett grün -> freigegeben (merge + needs-answer entfernt), kein Fix-Agent', () => {
    const gh = ghFake({
      prList: [{ number: 601, headRefName: 'fix/401-x' }],
      checks: { '601': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
    });
    const outcome = watchWaitingIssues([issue(401)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(outcome.released).toEqual([401]);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '401', '--remove-label', 'needs-answer']);
  });

  it('#196: kein verwaister Marker -- needs-answer verschwindet mit dem Merge', () => {
    const gh = ghFake({
      prList: [{ number: 601, headRefName: 'fix/401-x' }],
      checks: { '601': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
    });
    watchWaitingIssues([issue(401)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(gh.run).toHaveBeenCalledWith(expect.arrayContaining(['--remove-label', 'needs-answer']));
  });

  // #272: die Wache nimmt GENAU das Wartelabel ab. 'in-progress' bleibt stehen
  // -- das Ticket schliesst der Squash-Commit über 'Closes #N', nicht die
  // Wache. Bis S2b stand hier das Gegenteil: ein freigegebenes Ticket musste
  // von 'parked' auf 'in-progress' zurückbefördert werden.
  it('#272: der Merge fasst nur needs-answer an, nicht in-progress', () => {
    const gh = ghFake({
      prList: [{ number: 601, headRefName: 'fix/401-x' }],
      checks: { '601': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
    });
    watchWaitingIssues([issue(401)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    const edits = (gh.run as unknown as { mock: { calls: [string[]][] } }).mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(edits).toEqual([['issue', 'edit', '401', '--remove-label', 'needs-answer']]);
  });

  // #167: der Entwurfsstatus heißt "der Lauf ist nicht sauber zu Ende
  // gekommen". Auto-Merge auf einem Draft greift nicht -- die Reihenfolge
  // ready -> merge -> Label ist deshalb Bedingung, keine Kosmetik.
  it('#167: erst aus dem Entwurf heben, dann mergen, dann das Wartelabel abnehmen', () => {
    const gh = ghFake({
      prList: [{ number: 601, headRefName: 'fix/401-x' }],
      checks: { '601': [{ bucket: 'pass', name: 'quality' }] },
    });
    watchWaitingIssues([issue(401)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    const sequence = (gh.run as unknown as { mock: { calls: [string[]][] } }).mock.calls
      .map((c) => c[0])
      .filter((args) => (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'merge')) || args[1] === 'edit')
      .map((args) => `${args[0]} ${args[1]}`);
    expect(sequence).toEqual(['pr ready', 'pr merge', 'issue edit']);
  });

  it('T2/T3: PR pending -> bleibt unverändert wartend', () => {
    const ghPending = ghFake({
      prList: [{ number: 602, headRefName: 'fix/402-x' }],
      checks: { '602': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pending', name: 'e2e' }] },
    });
    expect(watchWaitingIssues([issue(402)], { gh: ghPending, git: gitFake(), state, clock: FIXED_CLOCK })).toEqual({ released: [] });
  });

  it('T5: mehrere wartende Tickets -- eins grün (freigegeben), eins pending (bleibt)', () => {
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
    const outcome = watchWaitingIssues([issue(501), issue(502, '2024-01-02T00:00:00Z')], {
      gh,
      git: gitFake(),
      state,
      clock: FIXED_CLOCK,
    });
    expect(outcome.released).toEqual([501]);
  });

  it('T7: hinter main + echter Merge-Konflikt -> bleibt still, kein Entparken mehr (#272)', () => {
    const gh = ghFake({
      prList: [{ number: 720, headRefName: 'fix/420-x' }],
      checks: { '720': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '720': { headRefName: 'fix/420-x', mergeStateStatus: 'BEHIND' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts'] });
    expect(watchWaitingIssues([issue(420)], { gh, git, state, clock: FIXED_CLOCK })).toEqual({ released: [] });
    expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining(['--add-label', 'in-progress']));
  });

  it('T24 (#217 AC3): DIRTY-PR -> bleibt still', () => {
    const gh = ghFake({
      prList: [{ number: 753, headRefName: 'fix/453-x' }],
      checks: { '753': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '753': { headRefName: 'fix/453-x', mergeStateStatus: 'DIRTY' } },
    });
    const git = gitFake({ failMerge: true, conflictFiles: ['src/a.ts'] });
    expect(watchWaitingIssues([issue(453)], { gh, git, state, clock: FIXED_CLOCK })).toEqual({ released: [] });
  });

  // #217 AC4: ohne dieses Gate faellt das Ticket aus jeder Wache heraus --
  // Wartelabel weg, PR aber weiterhin offen und unbeobachtet.
  it('T25 (#217 AC4): scheitert "gh pr merge", behält das Ticket sein needs-answer', () => {
    const base = ghFake({
      prList: [{ number: 754, headRefName: 'fix/454-x' }],
      checks: { '754': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }] },
      mergeState: { '754': { headRefName: 'fix/454-x', mergeStateStatus: 'CLEAN' } },
    });
    const gh: GhAdapter = {
      run: vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'merge') throw new Error('merge failed');
        return base.run(args);
      }),
    };
    const outcome = watchWaitingIssues([issue(454)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(outcome.released).toEqual([]);
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'edit', '454', '--remove-label', 'needs-answer']);
  });

  it('T8: rote Checks über protected-paths hinaus -> bleibt still', () => {
    const gh = ghFake({
      prList: [{ number: 721, headRefName: 'fix/421-x' }],
      checks: { '721': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'e2e', description: '2 tests failed' }] },
    });
    expect(watchWaitingIssues([issue(421)], { gh, git: gitFake(), state, clock: FIXED_CLOCK })).toEqual({ released: [] });
  });

  it('T9: nur protected-paths rot -> bleibt still', () => {
    const gh = ghFake({
      prList: [{ number: 722, headRefName: 'fix/422-x' }],
      checks: { '722': [{ bucket: 'pass', name: 'quality' }, { bucket: 'fail', name: 'protected-paths', description: 'Approval missing' }] },
    });
    expect(watchWaitingIssues([issue(422)], { gh, git: gitFake(), state, clock: FIXED_CLOCK })).toEqual({ released: [] });
  });

  // #272: die eigentliche Zusicherung dieser Stufe -- ein Ticket, das auf eine
  // Antwort wartet, wird NIE von selbst weitergebaut, egal wie sein PR steht.
  it('ein wartendes Ticket wird nie automatisch fortgesetzt, egal wie rot der PR ist', () => {
    const gh = ghFake({
      prList: [{ number: 723, headRefName: 'fix/423-x' }],
      checks: { '723': [{ bucket: 'fail', name: 'e2e', description: '2 tests failed' }] },
    });
    watchWaitingIssues([issue(423)], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining(['--remove-label', 'needs-answer']));
  });

  it('#272: es gibt keinen Bauplatz-Vorbehalt mehr -- zwei wartende Tickets ändern nichts aneinander', () => {
    const gh = ghFake({
      prList: [
        { number: 825, headRefName: 'fix/425-x' },
        { number: 828, headRefName: 'fix/428-x' },
      ],
      checks: {
        '825': [{ bucket: 'fail', name: 'e2e', description: '2 tests failed' }],
        '828': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }],
      },
    });
    const outcome = watchWaitingIssues([issue(425), issue(428, '2024-02-01T00:00:00Z')], { gh, git: gitFake(), state, clock: FIXED_CLOCK });
    expect(outcome.released).toEqual([428]);
  });

  it('T12: die Reihenfolge folgt createdAt, nicht der Übergabereihenfolge', () => {
    const gh = ghFake({
      prList: [
        { number: 826, headRefName: 'fix/426-x' },
        { number: 827, headRefName: 'fix/427-x' },
      ],
      checks: {
        '826': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }],
        '827': [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }],
      },
    });
    // Bewusst in "falscher" Reihenfolge übergeben -- watchWaitingIssues sortiert
    // selbst nach createdAt, wie PARKED_LIST in der Bash-Vorlage.
    const outcome = watchWaitingIssues([issue(427, '2025-06-01T00:00:00Z'), issue(426, '2024-01-01T00:00:00Z')], {
      gh,
      git: gitFake(),
      state,
      clock: FIXED_CLOCK,
    });
    expect(outcome.released).toEqual([426, 427]);
  });

  it('kein offener PR fürs Ticket -> wird übersprungen, kein Fehler', () => {
    const gh = ghFake({ prList: [] });
    expect(watchWaitingIssues([issue(999)], { gh, git: gitFake(), state, clock: FIXED_CLOCK })).toEqual({ released: [] });
  });
});
