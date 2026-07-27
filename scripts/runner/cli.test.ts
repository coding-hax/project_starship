import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFixedClock } from './clock';
import { commands, dispatch, type RunnerContext } from './cli';

function fakeContext(): RunnerContext {
  return {
    gh: { run: vi.fn().mockReturnValue('') },
    git: { run: vi.fn().mockReturnValue('') },
    state: {
      read: vi.fn().mockReturnValue(null),
      write: vi.fn(),
      exists: vi.fn().mockReturnValue(false),
      remove: vi.fn(),
    },
    clock: createFixedClock(new Date('2026-07-26T12:00:00Z')),
  };
}

describe('dispatch', () => {
  it('runs `version`, writes it to stdout and returns exit code 0', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = fakeContext();

    const rc = dispatch(ctx, ['version']);

    const pkgVersion = (
      JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
        version: string;
      }
    ).version;
    expect(rc).toBe(0);
    expect(stdout).toHaveBeenCalledWith(`${pkgVersion}\n`);
    // Ein triviales Kommando darf trotzdem keinen der Adapter anfassen.
    expect(ctx.gh.run).not.toHaveBeenCalled();
    expect(ctx.git.run).not.toHaveBeenCalled();
    expect(ctx.state.write).not.toHaveBeenCalled();

    stdout.mockRestore();
  });

  it('exits 2 and writes to stderr, never stdout, for an unknown command', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const rc = dispatch(fakeContext(), ['does-not-exist']);

    expect(rc).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('does-not-exist'));

    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('exits 2 for a missing command, same as an unknown one', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const rc = dispatch(fakeContext(), []);

    expect(rc).toBe(2);

    stderr.mockRestore();
  });

  it('registers exactly the commands this stage promises', () => {
    expect(Object.keys(commands)).toEqual([
      'version',
      'shim-drift-reason',
      'fmt-hm',
      'd-plus',
      'reset-epoch',
      'queue-order-flat',
      'queue-pending',
      'queue-next',
      'sha1-of',
      'tier-current',
      'tier-bump',
      'tier-reset',
      'resume-allowed',
      'blocker-sig',
      'build-escalation-eval',
      'opus-cap-reached',
      'opus-cap-reserve',
      'pr-for-issue',
      'pr-ci-state',
      'pr-is-behind',
      'pr-is-dirty',
      'pr-merge-state',
      'pr-catch-up-behind',
      'catchup-fail-reason',
      'catchup-fail-escalated',
      'catchup-fail-reset',
      'pr-only-protected-paths-red',
      'pr-squash-merge',
      'reopen-falsely-closed-issues',
      'pr-failure-summary',
      'watch-running-issue',
      'watch-parked-issues',
      'self-heal-park',
      'pick-ticket',
      'waiting-issues',
      'answer-issues',
      'approve-issues',
      'parked-issues',
      'parked-answer-issues',
      'parked-approve-issues',
      'park-issue',
      'cleanup-state',
      'queue-snapshot',
      'queue-body',
      // S6 (#203): das Rundenprotokoll -- drei Kommandos statt der bisherigen
      // ~40 Einzelaufrufe pro Takt, aufgeteilt am `claude`-Aufruf.
      'round-plan',
      'round-prompt',
      'round-eval',
    ]);
  });

  it('exits 1 with no stdout when a command signals failure (null), like a failed bash function', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // nicht-numerische Eingabe -> fmtHm() gibt null zurueck, wie ein
    // fehlgeschlagener `date`-Aufruf auf der Bash-Seite.
    const rc = dispatch(fakeContext(), ['fmt-hm', 'nicht-numerisch']);

    expect(rc).toBe(1);
    expect(stdout).not.toHaveBeenCalled();

    stdout.mockRestore();
  });

  it('runs `queue-next`, writing an empty line + exit 0 when nothing is buildable', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const rc = dispatch(fakeContext(), ['queue-next', '[]']);

    expect(rc).toBe(0);
    expect(stdout).toHaveBeenCalledWith('\n');

    stdout.mockRestore();
  });

  it('runs `queue-pending`, reflecting the clock-independent pure queue logic', () => {
    const snapshot = JSON.stringify([{ number: 60, labels: [{ name: 'needs-research' }] }]);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const rc = dispatch(fakeContext(), ['queue-pending', snapshot]);

    expect(rc).toBe(0);
    expect(stdout).toHaveBeenCalledWith('#60\n');

    stdout.mockRestore();
  });

  it('runs `reset-epoch` using the injected clock, not the real one', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = fakeContext(); // Uhr fix auf 2026-07-26T12:00:00Z

    const rc = dispatch(ctx, ['reset-epoch', 'session limit · resets 2:50pm (Europe/Berlin)']);

    expect(rc).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^\d+\n$/));

    stdout.mockRestore();
  });

  it('maps `pr-catch-up-behind` to the full 0-5 exit-code range, not just 0/1 (#201)', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = fakeContext();
    (ctx.gh.run as ReturnType<typeof vi.fn>).mockReturnValue('');

    // Kein Branch ermittelbar (gh liefert '') -> fetchFailed, Exit 3, kein stdout.
    const rc = dispatch(ctx, ['pr-catch-up-behind', '55']);

    expect(rc).toBe(3);
    expect(stdout).not.toHaveBeenCalled();
    // pr_catch_up_behind() darf bei fehlenden PR-Metadaten kein git anfassen.
    expect(ctx.git.run).not.toHaveBeenCalled();

    stdout.mockRestore();
  });

  it('`pr-catch-up-behind` writes conflict files without a trailing newline (printf parity)', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = fakeContext();
    (ctx.gh.run as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ headRefName: 'fix/1-x', mergeStateStatus: 'BEHIND' }),
    );
    (ctx.git.run as ReturnType<typeof vi.fn>).mockImplementation((args: string[]) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return 'main';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('conflict');
      if (args[0] === 'diff') return 'src/a.ts\nsrc/b.ts';
      return '';
    });

    const rc = dispatch(ctx, ['pr-catch-up-behind', '55']);

    expect(rc).toBe(1);
    expect(stdout).toHaveBeenCalledWith('src/a.ts,src/b.ts');

    stdout.mockRestore();
  });

  // Der isMain-Zweig greift nur beim Ausfuehren als Hauptmodul -- ein
  // bloßer Import triggert ihn nicht, deshalb ueber einen echten
  // Kindprozess statt `dispatch()` direkt (#251).
  describe('running as main module over a symlink path (#251)', () => {
    const tsxBin = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    function withSymlinkedCli(run: (cliViaLink: string) => void): void {
      const base = mkdtempSync(join(tmpdir(), 'starship-cli-'));
      try {
        symlinkSync(__dirname, join(base, 'runner'), 'dir');
        run(join(base, 'runner', 'cli.ts'));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    it('runs `version` over a symlink path, same as a direct call', () => {
      const pkgVersion = (
        JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
          version: string;
        }
      ).version;

      withSymlinkedCli((cliViaLink) => {
        const out = execFileSync(tsxBin, [cliViaLink, 'version'], { encoding: 'utf-8' });
        expect(out.trim()).toBe(pkgVersion);
      });
    }, 20000);

    it('exits non-zero for an unknown command over a symlink path', () => {
      withSymlinkedCli((cliViaLink) => {
        let status: number | null = null;
        try {
          execFileSync(tsxBin, [cliViaLink, 'does-not-exist'], { encoding: 'utf-8', stdio: 'pipe' });
        } catch (error) {
          status = (error as { status: number | null }).status;
        }
        expect(status).toBe(2);
      });
    }, 20000);
  });
});
