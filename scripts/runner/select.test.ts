import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import { createStateAdapter, type StateAdapter } from './state';
import { pickTicket, selectTicket, selfHealPark } from './select';
import type { QueueIssue } from './queue';

function label(...names: string[]) {
  return names.map((name) => ({ name }));
}

function issue(number: number, labels: string[], createdAt = '2024-01-01T00:00:00Z'): QueueIssue {
  return { number, labels: label(...labels), createdAt };
}

function ghDouble(): GhAdapter {
  return { run: vi.fn().mockReturnValue('') };
}

describe('selfHealPark (#145)', () => {
  it('parkt ein Ticket mit in-progress + needs-input, behaelt needs-input', () => {
    const gh = ghDouble();
    const snapshot = [issue(50, ['in-progress', 'needs-input']), issue(70, ['ready'])];
    const result = selfHealPark(snapshot, gh);
    expect(result.parked).toEqual([50]);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '50', '--remove-label', 'in-progress', '--add-label', 'parked']);
    const updated50 = result.snapshot.find((i) => i.number === 50)!;
    expect(updated50.labels.map((l) => l.name).sort()).toEqual(['needs-input', 'parked']);
  });

  it('laesst Tickets ohne beide Labels unangetastet', () => {
    const gh = ghDouble();
    const snapshot = [issue(60, ['in-progress']), issue(61, ['needs-input', 'parked'])];
    const result = selfHealPark(snapshot, gh);
    expect(result.parked).toEqual([]);
    expect(gh.run).not.toHaveBeenCalled();
    expect(result.snapshot).toEqual(snapshot);
  });

  it('ein gescheiterter gh-Aufruf laesst das Ticket in-progress+needs-input (Sicherheitsnetz greift danach)', () => {
    const gh: GhAdapter = {
      run: vi.fn(() => {
        throw new Error('gh failed');
      }),
    };
    const snapshot = [issue(50, ['in-progress', 'needs-input'])];
    const result = selfHealPark(snapshot, gh);
    expect(result.parked).toEqual([]);
    expect(result.snapshot).toEqual(snapshot);
  });

  it('#196: raeumt ein verwaistes needs-answer ab (needs-input schon weg)', () => {
    const gh = ghDouble();
    const snapshot = [issue(80, ['needs-answer']), issue(70, ['ready'])];
    const result = selfHealPark(snapshot, gh);
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '80', '--remove-label', 'needs-answer']);
    const updated80 = result.snapshot.find((i) => i.number === 80)!;
    expect(updated80.labels).toEqual([]);
  });

  it('#196: needs-answer bleibt, solange needs-input noch offen ist', () => {
    const gh = ghDouble();
    const snapshot = [issue(81, ['needs-input', 'needs-answer'])];
    const result = selfHealPark(snapshot, gh);
    expect(gh.run).not.toHaveBeenCalled();
    expect(result.snapshot).toEqual(snapshot);
  });

  it('#196: ein frisch geparktes Ticket behaelt sein needs-answer in DERSELBEN Runde (erst geparkt, dann noch needs-input)', () => {
    const gh = ghDouble();
    const snapshot = [issue(51, ['in-progress', 'needs-input', 'needs-answer'])];
    const result = selfHealPark(snapshot, gh);
    expect(result.parked).toEqual([51]);
    const updated51 = result.snapshot.find((i) => i.number === 51)!;
    expect(updated51.labels.map((l) => l.name).sort()).toEqual(['needs-answer', 'needs-input', 'parked']);
  });
});

describe('selectTicket (reine Auswahl-Kaskade)', () => {
  it('laufendes in-progress hat Vorrang vor allem anderen', () => {
    const snapshot = [issue(50, ['in-progress']), issue(70, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 50, role: 'build', source: 'running' });
  });

  it('in-progress MIT needs-input zaehlt nicht als laufend (Ticket wartet auf den Menschen)', () => {
    const snapshot = [issue(50, ['in-progress', 'needs-input']), issue(70, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 70, role: 'build', source: 'ready' });
  });

  it('ein geparktes Ticket (Frage beantwortet) geht vor einem frischen ready-Ticket', () => {
    const snapshot = [issue(50, ['parked'], '2024-01-01T00:00:00Z'), issue(70, ['ready'], '2024-01-02T00:00:00Z')];
    expect(selectTicket(snapshot)).toEqual({ issue: 50, role: 'build', source: 'resume-parked' });
  });

  it('ein geparktes Ticket MIT needs-input bleibt inert -- blockiert nichts, wird selbst nicht gewaehlt', () => {
    const snapshot = [issue(61, ['needs-input', 'parked'], '2020-01-01T00:00:00Z'), issue(90, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 90, role: 'build', source: 'ready' });
  });

  it('die Prioritaets-Queue schlaegt die Label-Kaskade, Label ist fuer den Rang egal', () => {
    const snapshot = [issue(99, ['ready'], '2024-01-01T00:00:00Z'), issue(10, ['needs-plan'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '#10, #99')).toEqual({ issue: 10, role: 'plan', source: 'queue' });
  });

  it('needs-plan hat Vorrang vor needs-research, auch bei niedrigerer Nummer (Fallback ohne Queue)', () => {
    const snapshot = [issue(10, ['needs-research']), issue(60, ['needs-plan'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 60, role: 'plan', source: 'needs-plan' });
  });

  it('needs-research wird gewaehlt, wenn kein needs-plan ansteht', () => {
    const snapshot = [issue(47, ['needs-research'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 47, role: 'research', source: 'needs-research' });
  });

  it('no-opus ueberspringt ein needs-research-Ticket komplett -- faellt auf ready durch', () => {
    const snapshot = [issue(47, ['needs-research', 'no-opus']), issue(48, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 48, role: 'build', source: 'ready' });
  });

  it('needs-research UND ready gleichzeitig wird ueber needs-research verarbeitet, nicht als Bau-Ticket', () => {
    const snapshot = [issue(50, ['needs-research', 'ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 50, role: 'research', source: 'needs-research' });
  });

  it('ready waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(99, ['ready'], '2024-01-01T00:00:00Z'), issue(10, ['ready'], '2024-06-01T00:00:00Z')];
    expect(selectTicket(snapshot)?.issue).toBe(99);
  });

  it('needs-plan waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(77, ['needs-plan'], '2024-01-01T00:00:00Z'), issue(5, ['needs-plan'], '2024-06-01T00:00:00Z')];
    expect(selectTicket(snapshot)?.issue).toBe(77);
  });

  it('laufendes Ticket (WIP) waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(50, ['in-progress'], '2024-01-01T00:00:00Z'), issue(3, ['in-progress'], '2024-06-01T00:00:00Z')];
    expect(selectTicket(snapshot)?.issue).toBe(50);
  });

  it('nichts waehlbar -> null', () => {
    expect(selectTicket([issue(1, ['needs-input'])])).toBeNull();
    expect(selectTicket([])).toBeNull();
  });
});

describe('pickTicket (Orchestrierung: Mutation + MODE)', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-select-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('Sicherheitsnetz: bleibt ein Ticket trotz selfHealPark in-progress+needs-input, wird alles blockiert', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress', 'needs-input'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'blocked', issues: [50] });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('laufendes Ticket: keine Mutation, MODE=resume', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('Resume eines geparkten Tickets: parked->in-progress, MODE=resume (Session bleibt, kein Neustart)', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['parked'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '50', '--add-label', 'in-progress', '--remove-label', 'parked']);
  });

  it('Queue-Pick mit role=build: ready->in-progress, MODE=start', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(70, ['ready'])], '#70', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '70', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('Queue-Pick mit role=plan: keine Label-Mutation, MODE=start ohne Session', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(60, ['needs-plan'])], '#60', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 60, role: 'plan', mode: 'start' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('needs-plan-Fallback mit vorhandener Session -> MODE=resume', () => {
    state.write('session-47', 'sess-abc123');
    const gh = ghDouble();
    const outcome = pickTicket([issue(47, ['needs-research'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 47, role: 'research', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('ready-Fallback: ready->in-progress, MODE=start', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(48, ['ready'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 48, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '48', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('nichts waehlbar -> none, keine Mutation', () => {
    const gh = ghDouble();
    expect(pickTicket([], '', gh, state)).toEqual({ kind: 'none' });
    expect(gh.run).not.toHaveBeenCalled();
  });
});
