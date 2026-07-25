import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateAdapter } from './state';

// Jeder Testfall bekommt ein eigenes Wegwerf-Verzeichnis -- niemals das echte
// .runner/ des Repos, wie in CLAUDE.md unter Token-/Sicherheitsdisziplin
// gefordert (#198 AC5).
describe('createStateAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing file as absent instead of throwing', () => {
    const state = createStateAdapter(dir);

    expect(state.exists('limit-until')).toBe(false);
    expect(state.read('limit-until')).toBeNull();
  });

  it('writes and reads a file back through the same base dir', () => {
    const state = createStateAdapter(dir);

    state.write('limit-until', '123');

    expect(state.exists('limit-until')).toBe(true);
    expect(state.read('limit-until')).toBe('123');
  });

  it('creates the base dir on write if it does not exist yet', () => {
    const nested = join(dir, 'nested');
    const state = createStateAdapter(nested);

    state.write('session-1', 'sid');

    expect(state.read('session-1')).toBe('sid');
  });
});
