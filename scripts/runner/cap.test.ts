import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixedClock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import { opusBuildCapClear, opusBuildCapReached, opusBuildCapReserve, thinkingCapReached, thinkingCapReserve } from './cap';

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

  // #900 AK3: opusBuildCapClear loescht nur den heutigen Zaehler dieses Tickets.
  it('clear removes only today\'s counter for the given issue', () => {
    state.write('opus-build-20260726-206', '2\n');
    opusBuildCapClear(206, state, clock);
    expect(state.exists('opus-build-20260726-206')).toBe(false);
  });

  it('clear leaves a counter for a different day untouched', () => {
    state.write('opus-build-20260725-207', '2\n');
    opusBuildCapClear(207, state, clock);
    expect(state.read('opus-build-20260725-207')?.trim()).toBe('2');
  });

  it('clear leaves a counter for a different issue untouched', () => {
    state.write('opus-build-20260726-208', '2\n');
    opusBuildCapClear(209, state, clock);
    expect(state.read('opus-build-20260726-208')?.trim()).toBe('2');
  });

  it('clear on a missing counter is a no-op', () => {
    expect(() => opusBuildCapClear(210, state, clock)).not.toThrow();
    expect(state.exists('opus-build-20260726-210')).toBe(false);
  });
});

describe('thinkingCapReached / thinkingCapReserve (#492)', () => {
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

  it('treats a missing counter file as 0 (not reached)', () => {
    expect(thinkingCapReached(state, clock)).toBe(false);
  });

  it('is not reached below the daily count of 20', () => {
    state.write('thinking-cap-20260726', '19\n');
    expect(thinkingCapReached(state, clock)).toBe(false);
  });

  it('is reached once the daily count hits 20', () => {
    state.write('thinking-cap-20260726', '20\n');
    expect(thinkingCapReached(state, clock)).toBe(true);
  });

  it('reserve increments one shared, ticket-uebergreifende counter for today', () => {
    thinkingCapReserve(state, clock);
    expect(state.read('thinking-cap-20260726')?.trim()).toBe('1');
    thinkingCapReserve(state, clock);
    expect(state.read('thinking-cap-20260726')?.trim()).toBe('2');
  });
});
