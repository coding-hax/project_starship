import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateAdapter, type StateAdapter } from './state';
import type { GhAdapter } from './gh';
import { tierBump, tierCurrent, tierFromLabels, tierReset } from './tier';

function ghReturning(labelsOutput: string): GhAdapter {
  return { run: vi.fn().mockReturnValue(labelsOutput) };
}

// ADR-0013: die Startstufe steht am Ticket. Drei Labels statt einem, und die
// Antwort ist bewusst 'null' statt 'sonnet', wenn keins gesetzt ist -- die
// Denk-Rollen brauchen den Unterschied zwischen "nichts gesetzt" (dann Opus)
// und "ausdruecklich Sonnet gewaehlt".
describe('tierFromLabels (#273)', () => {
  it('liest jede der drei Startstufen', () => {
    expect(tierFromLabels(1, ghReturning('ready\nmodel:haiku'))).toBe('haiku');
    expect(tierFromLabels(1, ghReturning('model:sonnet\nready'))).toBe('sonnet');
    expect(tierFromLabels(1, ghReturning('model:opus'))).toBe('opus');
  });

  it('ohne model:*-Label null -- nicht "sonnet"', () => {
    expect(tierFromLabels(1, ghReturning('ready\nin-progress'))).toBeNull();
  });

  it('bei mehreren Labels gewinnt die teuerste Stufe', () => {
    expect(tierFromLabels(1, ghReturning('model:haiku\nmodel:opus\nmodel:sonnet'))).toBe('opus');
  });

  it('null statt Absturz, wenn gh scheitert', () => {
    const gh: GhAdapter = {
      run: vi.fn().mockImplementation(() => {
        throw new Error('gh failed');
      }),
    };
    expect(tierFromLabels(1, gh)).toBeNull();
  });
});

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

  // ADR-0013 AC1: ohne Eskalation baut ein model:opus-Ticket sofort auf Opus.
  it('startet auf opus, wenn das Label es sagt -- ohne vorherige Eskalation', () => {
    expect(tierCurrent(105, state, ghReturning('ready\nmodel:opus'))).toBe('opus');
    expect(state.exists('tier-105')).toBe(false);
  });

  // Das Label ist die Startstufe, nicht die Fessel: eine schon eingetretene
  // Eskalation schlaegt es. Ohne diese Richtung waere ein 'model:sonnet'-Ticket
  // fuer immer auf Sonnet festgenagelt und ADR-0007 liefe ins Leere.
  it('die eskalierte Stufe schlaegt ein niedrigeres Startstufen-Label', () => {
    state.write('tier-106', 'opus\n');
    expect(tierCurrent(106, state, ghReturning('model:sonnet'))).toBe('opus');
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

  // ADR-0013 AC4: ein Ticket, das mit 'model:opus' startet, hat die Leiter
  // schon oben betreten -- ohne tier-Datei. Drei erfolglose Laeufe fuehren
  // deshalb direkt zu "Eskalation erschoepft", nicht zu einem vierten Modell.
  it('ist von einem model:opus-Start aus sofort erschoepft, ohne tier-Datei', () => {
    expect(tierBump(107, state, ghReturning('ready\nmodel:opus'))).toBe(false);
  });

  it('schaltet von einem model:haiku-Start regulaer auf opus hoch', () => {
    const gh = ghReturning('ready\nmodel:haiku');
    expect(tierBump(108, state, gh)).toBe(true);
    expect(tierCurrent(108, state, gh)).toBe('opus');
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
