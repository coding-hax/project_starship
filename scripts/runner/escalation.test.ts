import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixedClock } from './clock';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createStateAdapter, type StateAdapter } from './state';
import { tierCurrent } from './tier';
import { blockerSig, buildEscalationEval, resumeAllowed, sha1Of } from './escalation';

const PROGRESS_COMMENT = (line: string) =>
  `## 🤖 Fortschritt (automatisch aktualisiert)\n\n_Lauf-Ende 16.07. 10:00: ${line}_`;

function ghComments(body: string): GhAdapter {
  return { run: vi.fn().mockReturnValue(body) };
}

// Args-bewusster Double: blockerSig fragt mit -q nach dem letzten Body,
// progressCommentWrittenThisRun fragt ohne -q nach dem rohen comments-Array.
function ghWithComments(comments: Array<{ body: string; createdAt: string }>): GhAdapter {
  return {
    run: vi.fn().mockImplementation((args: string[]) => {
      if (args.includes('-q')) {
        const last = comments[comments.length - 1];
        return last ? last.body : '';
      }
      return JSON.stringify({ comments });
    }),
  };
}

function gitTip(sha: string): GitAdapter {
  return {
    run: vi.fn().mockReturnValue(sha ? `${sha}\trefs/heads/feat/1-x` : ''),
  };
}

describe('sha1Of', () => {
  it('matches the well-known sha1 of an empty string, like `shasum -a 1`', () => {
    expect(sha1Of('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});

describe('blockerSig', () => {
  it('returns "" when the last comment is not the progress comment', () => {
    expect(blockerSig(1, ghComments('irgendein anderer Kommentar'))).toBe('');
  });

  it('returns "" when the progress comment has no blocker keyline', () => {
    expect(
      blockerSig(1, ghComments('## 🤖 Fortschritt (automatisch aktualisiert)\n\n- [x] alles grün')),
    ).toBe('');
  });

  it('hashes the blocker keylines of the progress comment', () => {
    const body = PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.');
    const gh = ghComments(body);
    const sig = blockerSig(1, gh);
    expect(sig).not.toBe('');
    expect(sig).toBe(blockerSig(1, ghComments(body))); // deterministisch
  });

  it('falls back to "" when gh fails', () => {
    const gh: GhAdapter = {
      run: vi.fn().mockImplementation(() => {
        throw new Error('gh failed');
      }),
    };
    expect(blockerSig(1, gh)).toBe('');
  });
});

describe('resumeAllowed', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-resume-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC5: allows the first two resumes, caps the third and resets the counter', () => {
    expect(resumeAllowed(201, state).allowed).toBe(true);
    expect(resumeAllowed(201, state).allowed).toBe(true);
    expect(resumeAllowed(201, state).allowed).toBe(false);
    expect(state.read('resume-count-201')?.trim()).toBe('0');

    expect(resumeAllowed(201, state).allowed).toBe(true); // neuer Zyklus
  });

  it('AC6: counts per ticket number, independent of other tickets', () => {
    resumeAllowed(202, state);
    resumeAllowed(202, state);
    resumeAllowed(999, state);
    expect(state.read('resume-count-999')?.trim()).toBe('1');
    expect(state.read('resume-count-202')?.trim()).toBe('2');
  });
});

describe('buildEscalationEval', () => {
  let dir: string;
  let state: StateAdapter;
  const clock = createFixedClock(new Date(2026, 6, 26, 10, 0, 0));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-escalation-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC1: no progress, same signature -> failcount rises to 1', () => {
    buildEscalationEval(
      {
        issue: 101,
        runRole: 'build',
        labels: '',
        beforeTip: 'sha-alt',
        model: 'sonnet',
      },
      state,
      ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.')),
      gitTip(''), // kein Branch -> kein Fortschritt
      clock,
    );
    expect(state.read('failcount-101')?.trim()).toBe('1');
  });

  it('AC3: three failed runs escalate sonnet to opus and reset the failcount', () => {
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    const git = gitTip('');
    const input = { issue: 103, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'sonnet' };

    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);

    expect(tierCurrent(103, state, gh)).toBe('opus');
    expect(state.read('failcount-103')?.trim()).toBe('0');
  });

  it('AC4: a moved branch tip resets the tier to default and clears the failcount', () => {
    state.write('tier-104', 'opus\n');
    state.write('failcount-104', '2\n');
    state.write('blocker-sig-104', 'irgendeine-sig');

    buildEscalationEval(
      { issue: 104, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'opus' },
      state,
      ghComments(''),
      gitTip('sha-neu'), // Branch hat sich bewegt
      clock,
    );

    expect(tierCurrent(104, state, ghComments(''))).toBe('sonnet');
    expect(state.exists('failcount-104')).toBe(false);
  });

  // #900 AK1/AK2: Fortschritt loescht den Opus-Tageszaehler, ausbleibender
  // Fortschritt laesst ihn unangetastet.
  it('#900 AK1: a moved branch tip clears the opus daily build cap counter', () => {
    state.write('opus-build-20260726-108', '2\n');

    buildEscalationEval(
      { issue: 108, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'opus' },
      state,
      ghComments(''),
      gitTip('sha-neu'), // Branch hat sich bewegt
      clock,
    );

    expect(state.exists('opus-build-20260726-108')).toBe(false);
  });

  it('#900 AK2: no progress leaves the opus daily build cap counter untouched', () => {
    state.write('opus-build-20260726-109', '2\n');

    buildEscalationEval(
      { issue: 109, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'opus' },
      state,
      ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.')),
      gitTip(''), // kein Branch -> kein Fortschritt
      clock,
    );

    expect(state.read('opus-build-20260726-109')?.trim()).toBe('2');
  });

  it('AC5: no-escalation prevents any tier bump, even after three failed runs', () => {
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    const git = gitTip('');
    const input = {
      issue: 105,
      runRole: 'build',
      labels: 'no-escalation',
      beforeTip: 'sha-alt',
      model: 'sonnet',
    };

    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);

    expect(state.exists('tier-105')).toBe(false);
  });

  it('AC7: a differing blocker signature resets the failcount to 0', () => {
    state.write('failcount-107', '2\n');
    state.write('blocker-sig-107', 'alte-signatur-die-nirgendwo-vorkommt');

    buildEscalationEval(
      { issue: 107, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'sonnet' },
      state,
      ghComments(PROGRESS_COMMENT('gate-rot — ein ANDERER Test schlägt jetzt fehl.')),
      gitTip(''),
      clock,
    );

    expect(state.read('failcount-107')?.trim()).toBe('0');
  });

  it('removes the opus-boost label after a fruitless opus run (T3)', () => {
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    buildEscalationEval(
      { issue: 203, runRole: 'build', labels: 'in-progress opus-boost', beforeTip: 'sha-alt', model: 'opus' },
      state,
      gh,
      gitTip(''),
      clock,
    );
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '203', '--remove-label', 'opus-boost']);
  });

  it('leaves opus-boost untouched on progress (T4)', () => {
    state.write('tier-204', 'opus\n');
    const gh = ghComments('');
    buildEscalationEval(
      { issue: 204, runRole: 'build', labels: 'in-progress opus-boost', beforeTip: 'sha-alt', model: 'opus' },
      state,
      gh,
      gitTip('sha-neu'),
      clock,
    );
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'edit', '204', '--remove-label', 'opus-boost']);
    expect(tierCurrent(204, state, gh)).toBe('sonnet');
  });

  it('no-escalation wins over opus-boost -- the label stays inert (T5)', () => {
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    const git = gitTip('');
    const input = {
      issue: 205,
      runRole: 'build',
      labels: 'in-progress no-escalation opus-boost',
      beforeTip: 'sha-alt',
      model: 'opus',
    };

    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);

    expect(state.exists('tier-205')).toBe(false);
    expect(gh.run).not.toHaveBeenCalledWith(['issue', 'edit', '205', '--remove-label', 'opus-boost']);
  });

  // #272: hier standen bis S2b zwei Labels -- die Klammer 'needs-input' und der
  // Marker 'needs-answer' daneben. Es gibt nur noch eins.
  it('#272: sets needs-answer when opus itself is exhausted (one waiting label, not two)', () => {
    state.write('tier-206', 'opus\n');
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    const git = gitTip('');
    const input = { issue: 206, runRole: 'build', labels: '', beforeTip: 'sha-alt', model: 'opus' };

    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);
    buildEscalationEval(input, state, gh, git, clock);

    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '206', '--add-label', 'needs-answer']);
    expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining(['needs-input']));
  });

  it('does nothing outside of the build role', () => {
    const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
    buildEscalationEval(
      { issue: 300, runRole: 'plan', labels: '', beforeTip: 'sha-alt', model: 'opus' },
      state,
      gh,
      gitTip(''),
      clock,
    );
    expect(state.exists('failcount-300')).toBe(false);
    expect(gh.run).not.toHaveBeenCalled();
  });

  // #741: eine offene Frage (needs-answer) ist kein inhaltlicher Fehlversuch
  // -- weder failcount- noch der F26-Waechter duerfen dann greifen. Die
  // Branch-Tip-Pruefung (Fortschritt setzt zurueck) bleibt davon unberuehrt.
  describe('#741: nonFailureReason (z. B. needs-answer) ist kein Fehlversuch', () => {
    it('AC1/AC2: failcount- bleibt ungeschrieben, auch ueber mehrere Laeufe in Folge', () => {
      const gh = ghComments(PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'));
      const git = gitTip('');
      const input = {
        issue: 501,
        runRole: 'build',
        labels: '',
        beforeTip: 'sha-alt',
        model: 'sonnet',
        nonFailureReason: 'needs-answer' as const,
      };

      buildEscalationEval(input, state, gh, git, clock);
      buildEscalationEval(input, state, gh, git, clock);
      buildEscalationEval(input, state, gh, git, clock);

      expect(state.exists('failcount-501')).toBe(false);
      expect(state.exists('tier-501')).toBe(false);
    });

    it('AC3: postet keine Auffaelligkeit, selbst bei stehender Spitze + frischem Fortschrittskommentar', () => {
      const gh = ghWithComments([
        {
          body: PROGRESS_COMMENT('frage-offen, unfertig — nächster Lauf macht weiter.'),
          createdAt: '2026-08-03T10:05:00Z',
        },
      ]);
      buildEscalationEval(
        {
          issue: 502,
          runRole: 'build',
          labels: '',
          beforeTip: '',
          model: 'sonnet',
          runStart: '2026-08-03T10:00:00Z',
          nonFailureReason: 'needs-answer',
        },
        state,
        gh,
        gitTip(''),
        clock,
      );
      expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('Auffälligkeit')]));
    });

    it('Fortschritt (bewegte Branch-Spitze) setzt trotzdem zurueck -- unabhaengig vom Endgrund', () => {
      state.write('tier-503', 'opus\n');
      state.write('failcount-503', '2\n');
      buildEscalationEval(
        {
          issue: 503,
          runRole: 'build',
          labels: '',
          beforeTip: 'sha-alt',
          model: 'opus',
          nonFailureReason: 'needs-answer',
        },
        state,
        ghComments(''),
        gitTip('sha-neu'),
        clock,
      );
      expect(tierCurrent(503, state, ghComments(''))).toBe('sonnet');
      expect(state.exists('failcount-503')).toBe(false);
    });
  });

  // F26/#499: Kommentar behauptet Fortschritt, Branch-Spitze steht -- der
  // #430-Fall.
  describe('F26/#499: Fortschritt ohne Commit', () => {
    it('AK1: standing tip + fresh progress comment this run -> reports an Auffälligkeit', () => {
      const gh = ghWithComments([
        { body: PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'), createdAt: '2026-08-03T10:05:00Z' },
      ]);
      buildEscalationEval(
        {
          issue: 401,
          runRole: 'build',
          labels: '',
          beforeTip: '',
          model: 'sonnet',
          runStart: '2026-08-03T10:00:00Z',
        },
        state,
        gh,
        gitTip(''), // kein Branch -> Spitze steht
        clock,
      );
      expect(gh.run).toHaveBeenCalledWith(['issue', 'comment', '401', '--body', expect.stringContaining('Auffälligkeit')]);
    });

    it('AK2: moved tip -> no Auffälligkeit even with a fresh progress comment', () => {
      const gh = ghWithComments([
        { body: PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'), createdAt: '2026-08-03T10:05:00Z' },
      ]);
      buildEscalationEval(
        {
          issue: 402,
          runRole: 'build',
          labels: '',
          beforeTip: 'sha-alt',
          model: 'sonnet',
          runStart: '2026-08-03T10:00:00Z',
        },
        state,
        gh,
        gitTip('sha-neu'),
        clock,
      );
      expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('Auffälligkeit')]));
    });

    it('AK3: standing tip + unchanged (stale) progress comment -> no Auffälligkeit, failcount still rises', () => {
      const gh = ghWithComments([
        { body: PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'), createdAt: '2026-08-03T09:00:00Z' },
      ]);
      buildEscalationEval(
        {
          issue: 403,
          runRole: 'build',
          labels: '',
          beforeTip: '',
          model: 'sonnet',
          runStart: '2026-08-03T10:00:00Z',
        },
        state,
        gh,
        gitTip(''),
        clock,
      );
      expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('Auffälligkeit')]));
      expect(state.read('failcount-403')?.trim()).toBe('1');
    });

    it('AK4: the progress comment itself is never edited or overwritten', () => {
      const gh = ghWithComments([
        { body: PROGRESS_COMMENT('gate-rot, unfertig — nächster Lauf macht weiter.'), createdAt: '2026-08-03T10:05:00Z' },
      ]);
      buildEscalationEval(
        {
          issue: 404,
          runRole: 'build',
          labels: '',
          beforeTip: '',
          model: 'sonnet',
          runStart: '2026-08-03T10:00:00Z',
        },
        state,
        gh,
        gitTip(''),
        clock,
      );
      const calls = (gh.run as ReturnType<typeof vi.fn>).mock.calls as string[][];
      expect(calls.some((call) => call.includes('--edit-last'))).toBe(false);
    });
  });
});
