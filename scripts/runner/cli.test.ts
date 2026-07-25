import { readFileSync } from 'node:fs';
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
    expect(Object.keys(commands)).toEqual(['version']);
  });
});
