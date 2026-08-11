import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixedClock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import { catchupCountWindow, recordCatchup } from './catchup-metrics';

const DAY_MS = 24 * 3600_000;

describe('catchup-metrics', () => {
  let dir: string;
  let sharedState: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catchup-metrics-'));
    sharedState = createStateAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recordCatchup haengt ein Ereignis an eine leere Slot-Datei an', () => {
    const clock = createFixedClock(new Date(1_000_000));
    recordCatchup('1', sharedState, clock);
    expect(sharedState.read('catchup-1.log')).toBe('1000000\n');
  });

  it('recordCatchup haengt an bestehende Ereignisse an, statt sie zu ueberschreiben', () => {
    recordCatchup('1', sharedState, createFixedClock(new Date(1_000_000)));
    recordCatchup('1', sharedState, createFixedClock(new Date(2_000_000)));
    expect(sharedState.read('catchup-1.log')).toBe('1000000\n2000000\n');
  });

  it('recordCatchup verwirft Zeilen aelter als 7 Tage', () => {
    const start = 10 * DAY_MS;
    recordCatchup('1', sharedState, createFixedClock(new Date(start)));
    const later = start + 8 * DAY_MS;
    recordCatchup('1', sharedState, createFixedClock(new Date(later)));
    expect(sharedState.read('catchup-1.log')).toBe(`${later}\n`);
  });

  it('catchupCountWindow summiert ueber mehrere Slot-Dateien', () => {
    const clock = createFixedClock(new Date(1_000_000));
    recordCatchup('1', sharedState, clock);
    recordCatchup('1', sharedState, clock);
    recordCatchup('2', sharedState, clock);
    expect(catchupCountWindow(['1', '2'], sharedState, clock)).toBe(3);
  });

  it('catchupCountWindow zaehlt eine fehlende Datei als 0', () => {
    const clock = createFixedClock(new Date(1_000_000));
    recordCatchup('1', sharedState, clock);
    expect(catchupCountWindow(['1', '2'], sharedState, clock)).toBe(1);
  });

  it('catchupCountWindow zaehlt nur Ereignisse innerhalb des Fensters', () => {
    const start = 0;
    recordCatchup('1', sharedState, createFixedClock(new Date(start)));
    const laterClock = createFixedClock(new Date(start + 8 * DAY_MS));
    recordCatchup('1', sharedState, laterClock);
    // Das erste Ereignis wurde beim zweiten recordCatchup schon geprunt
    // (>7 Tage) -- catchupCountWindow zaehlt hier nur noch das zweite.
    expect(catchupCountWindow(['1'], sharedState, laterClock)).toBe(1);
  });
});
