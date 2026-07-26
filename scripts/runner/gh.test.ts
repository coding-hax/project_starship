import { describe, expect, it, vi } from 'vitest';
import { createGhAdapter } from './gh';

describe('createGhAdapter', () => {
  it('delegates to the injected exec function instead of a real gh process', () => {
    const exec = vi.fn().mockReturnValue('stub-output');
    const gh = createGhAdapter(exec);

    const result = gh.run(['issue', 'view', '198']);

    expect(exec).toHaveBeenCalledWith('gh', ['issue', 'view', '198']);
    expect(result).toBe('stub-output');
  });

  it('strips trailing newlines, like bash `$(...)` command substitution (#201)', () => {
    const exec = vi.fn().mockReturnValue('log line 1\nlog line 2\n\n');
    const gh = createGhAdapter(exec);

    expect(gh.run(['run', 'view', '1', '--log-failed'])).toBe('log line 1\nlog line 2');
  });
});
