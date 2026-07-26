import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateAdapter, type StateAdapter } from './state';
import type { GhAdapter } from './gh';
import { tierBump, tierCurrent, tierReset } from './tier';

function ghReturning(labelsOutput: string): GhAdapter {
  return { run: vi.fn().mockReturnValue(labelsOutput) };
}

describe('tierCurrent', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-tier-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to sonnet when no tier file exists and the model:haiku label is absent', () => {
    expect(tierCurrent(101, state, ghReturning('ready\nin-progress'))).toBe('sonnet');
  });

  it('defaults to haiku when the model:haiku label is present', () => {
    expect(tierCurrent(101, state, ghReturning('model:haiku\nready'))).toBe('haiku');
  });

  it('falls back to sonnet when gh fails (no crash, matches the 2>/dev/null swallow)', () => {
    const gh: GhAdapter = {
      run: vi.fn().mockImplementation(() => {
        throw new Error('gh failed');
      }),
    };
    expect(tierCurrent(101, state, gh)).toBe('sonnet');
  });

  it('prefers an existing tier file over the label lookup', () => {
    state.write('tier-101', 'opus\n');
    const gh = ghReturning('');
    expect(tierCurrent(101, state, gh)).toBe('opus');
    expect(gh.run).not.toHaveBeenCalled();
  });
});

describe('tierBump', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-tier-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bumps sonnet to opus and resets the failcount', () => {
    const gh = ghReturning('');
    expect(tierBump(102, state, gh)).toBe(true);
    expect(tierCurrent(102, state, gh)).toBe('opus');
    expect(state.read('failcount-102')?.trim()).toBe('0');
  });

  it('reports exhaustion instead of bumping when already at opus', () => {
    state.write('tier-103', 'opus\n');
    expect(tierBump(103, state, ghReturning(''))).toBe(false);
  });
});

describe('tierReset', () => {
  it('removes tier, failcount, blocker-sig and branch-head for the ticket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-tier-'));
    const state = createStateAdapter(dir);
    state.write('tier-104', 'opus\n');
    state.write('failcount-104', '2\n');
    state.write('blocker-sig-104', 'abc123');
    state.write('branch-head-104', 'deadbeef');

    tierReset(104, state);

    expect(state.exists('tier-104')).toBe(false);
    expect(state.exists('failcount-104')).toBe(false);
    expect(state.exists('blocker-sig-104')).toBe(false);
    expect(state.exists('branch-head-104')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when nothing exists yet, matching `rm -f`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-tier-'));
    const state = createStateAdapter(dir);
    expect(() => tierReset(999, state)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
