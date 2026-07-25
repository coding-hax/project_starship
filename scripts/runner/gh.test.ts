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
});
