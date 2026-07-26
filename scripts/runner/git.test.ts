import { describe, expect, it, vi } from 'vitest';
import { createGitAdapter } from './git';

describe('createGitAdapter', () => {
  it('delegates to the injected exec function instead of a real git process', () => {
    const exec = vi.fn().mockReturnValue('stub-output');
    const git = createGitAdapter(exec);

    const result = git.run(['status', '--porcelain']);

    expect(exec).toHaveBeenCalledWith('git', ['status', '--porcelain']);
    expect(result).toBe('stub-output');
  });

  it('strips trailing newlines, like bash `$(...)` command substitution (#201)', () => {
    const exec = vi.fn().mockReturnValue('main\n');
    const git = createGitAdapter(exec);

    expect(git.run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});
