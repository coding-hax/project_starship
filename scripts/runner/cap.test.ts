import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixedClock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import { opusBuildCapReached, opusBuildCapReserve } from './cap';

describe('opusBuildCapReached / opusBuildCapReserve', () => {
  let dir: string;
  let state: StateAdapter;
  const clock = createFixedClock(new Date(2026, 6, 26, 10, 0, 0));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-cap-'));
    state = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not reached below the daily count of 2', () => {
    state.write('opus-build-20260726-201', '1\n');
    expect(opusBuildCapReached(201, '', state, clock)).toBe(false);
  });

  it('is reached once the daily count hits 2', () => {
    state.write('opus-build-20260726-202', '2\n');
    expect(opusBuildCapReached(202, 'in-progress', state, clock)).toBe(true);
  });

  it('is bypassed by the opus-boost label regardless of the count', () => {
    state.write('opus-build-20260726-203', '2\n');
    expect(opusBuildCapReached(203, 'opus-boost in-progress', state, clock)).toBe(false);
  });

  it('treats a missing counter file as 0 (not reached)', () => {
    expect(opusBuildCapReached(204, '', state, clock)).toBe(false);
  });

  it('reserve increments the counter for today, keyed by issue', () => {
    opusBuildCapReserve(205, state, clock);
    expect(state.read('opus-build-20260726-205')?.trim()).toBe('1');
    opusBuildCapReserve(205, state, clock);
    expect(state.read('opus-build-20260726-205')?.trim()).toBe('2');
  });
});
