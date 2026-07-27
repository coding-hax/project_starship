import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import { createStateAdapter, type StateAdapter } from './state';
import { pickTicket, selectTicket } from './select';
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

// #272: Diese Gruppe ersetzt die frueheren selfHealPark-Faelle. Der Zustand,
// den sie beschreiben, ist derselbe -- ein Ticket wartet auf eine Antwort --
// nur ohne Umlabeln: 'in-progress' bleibt stehen, 'needs-answer' kommt dazu.
describe('Wartezustand ohne Parken (#272)', () => {
  it('in-progress + needs-answer zaehlt nicht als laufend -- ein anderes Ticket wird gebaut', () => {
    const snapshot = [issue(50, ['in-progress', 'needs-answer']), issue(70, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 70, role: 'build', source: 'ready' });
  });

  it('faellt needs-answer weg, wird dasselbe Ticket ueber den running-Zweig fortgesetzt', () => {
    const snapshot = [issue(50, ['in-progress']), issue(70, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 50, role: 'build', source: 'running' });
  });

  it('needs-answer schliesst auch ohne in-progress aus', () => {
    expect(selectTicket([issue(50, ['ready', 'needs-answer'])])).toBeNull();
  });

  it('needs-answer schlaegt die Queue -- der naechste gelistete Eintrag kommt dran', () => {
    const snapshot = [issue(50, ['needs-answer']), issue(60, [])];
    expect(selectTicket(snapshot, '#50\n#60')).toEqual({ issue: 60, role: 'build', source: 'queue' });
  });

  it('ein plan-Ticket mit needs-answer wird nicht geplant', () => {
    const snapshot = [issue(50, ['plan', 'needs-answer']), issue(70, ['ready'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 70, role: 'build', source: 'ready' });
  });

  it('traegt jedes Ticket needs-answer, waehlt der Runner gar nichts', () => {
    const snapshot = [issue(50, ['in-progress', 'needs-answer']), issue(60, ['ready', 'needs-answer'])];
    expect(selectTicket(snapshot)).toBeNull();
  });
});

describe('selectTicket (reine Auswahl-Kaskade)', () => {
  it('laufendes in-progress hat Vorrang vor allem anderen', () => {
    expect(selectTicket([issue(10, ['ready']), issue(20, ['in-progress'])])).toEqual({
      issue: 20,
      role: 'build',
      source: 'running',
    });
  });

  it('in-progress MIT needs-answer zaehlt nicht als laufend (Ticket wartet auf den Menschen)', () => {
    expect(selectTicket([issue(20, ['in-progress', 'needs-answer']), issue(10, ['ready'])])).toEqual({
      issue: 10,
      role: 'build',
      source: 'ready',
    });
  });

  it('die Prioritaets-Queue schlaegt die Label-Kaskade, Label ist fuer den Rang egal', () => {
    const snapshot = [issue(10, ['ready']), issue(99, [])];
    expect(selectTicket(snapshot, '#99')).toEqual({ issue: 99, role: 'build', source: 'queue' });
  });

  it('plan hat Vorrang vor research, auch bei niedrigerer Nummer (Fallback ohne Queue)', () => {
    expect(selectTicket([issue(90, ['research']), issue(91, ['plan'])])).toEqual({
      issue: 91,
      role: 'plan',
      source: 'plan',
    });
  });

  it('research wird gewaehlt, wenn kein plan ansteht', () => {
    expect(selectTicket([issue(90, ['research'])])).toEqual({ issue: 90, role: 'research', source: 'research' });
  });

  it('hands-off ueberspringt ein research-Ticket komplett -- faellt auf ready durch', () => {
    expect(selectTicket([issue(90, ['research', 'hands-off']), issue(10, ['ready'])])).toEqual({
      issue: 10,
      role: 'build',
      source: 'ready',
    });
  });

  it('research UND ready gleichzeitig wird ueber research verarbeitet, nicht als Bau-Ticket', () => {
    expect(selectTicket([issue(90, ['research', 'ready'])])).toEqual({
      issue: 90,
      role: 'research',
      source: 'research',
    });
  });

  it('ready waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(99, ['ready'], '2024-01-01T00:00:00Z'), issue(10, ['ready'], '2024-06-01T00:00:00Z')];
    expect(selectTicket(snapshot)?.issue).toBe(99);
  });

  it('plan waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(99, ['plan'], '2024-01-01T00:00:00Z'), issue(10, ['plan'], '2024-06-01T00:00:00Z')];
    expect(selectTicket(snapshot)?.issue).toBe(99);
  });

  it('laufendes Ticket (WIP) waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [
      issue(99, ['in-progress'], '2024-01-01T00:00:00Z'),
      issue(10, ['in-progress'], '2024-06-01T00:00:00Z'),
    ];
    expect(selectTicket(snapshot)?.issue).toBe(99);
  });

  it('nichts waehlbar -> null', () => {
    expect(selectTicket([issue(10, [])])).toBeNull();
  });

  it('leerer Snapshot -> null', () => {
    expect(selectTicket([])).toBeNull();
  });
});

describe('selectTicket: hands-off gilt fuer jeden Zweig (#227)', () => {
  it('in-progress + hands-off wird nicht fortgesetzt -- faellt auf ready durch', () => {
    expect(selectTicket([issue(50, ['in-progress', 'hands-off']), issue(10, ['ready'])])?.issue).toBe(10);
  });

  it('ein wartendes hands-off-Ticket wird bei freiem Bauplatz nicht gewaehlt (der Vorfall vom 26.07.26)', () => {
    expect(selectTicket([issue(156, ['in-progress', 'needs-answer', 'hands-off']), issue(10, ['ready'])])?.issue).toBe(
      10,
    );
  });

  it('ready + hands-off wird nicht gebaut', () => {
    expect(selectTicket([issue(50, ['ready', 'hands-off'])])).toBeNull();
  });

  it('hands-off schlaegt die Queue -- der naechste gelistete Eintrag kommt dran', () => {
    const snapshot = [issue(50, ['hands-off']), issue(60, [])];
    expect(selectTicket(snapshot, '#50\n#60')?.issue).toBe(60);
  });

  it('hands-off ueberspringt ein plan-Ticket komplett -- faellt auf ready durch', () => {
    expect(selectTicket([issue(50, ['plan', 'hands-off']), issue(10, ['ready'])])?.issue).toBe(10);
  });

  it('traegt jedes Ticket hands-off, waehlt der Runner gar nichts', () => {
    expect(selectTicket([issue(50, ['ready', 'hands-off']), issue(60, ['plan', 'hands-off'])])).toBeNull();
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

  // #272: frueher war in-progress + Wartelabel ein Zwischenzustand, den ein
  // Sicherheitsnetz abfangen musste ('blocked'). Jetzt ist er regulaer -- das
  // Ticket wird schlicht uebersprungen, ohne dass irgendetwas blockiert.
  it('in-progress + needs-answer blockiert nichts mehr -- ein anderes Ticket wird gebaut', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress', 'needs-answer']), issue(70, ['ready'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
  });

  it('wartet alles auf eine Antwort, passiert gar nichts', () => {
    const gh = ghDouble();
    expect(pickTicket([issue(50, ['in-progress', 'needs-answer'])], '', gh, state)).toEqual({ kind: 'none' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('laufendes Ticket: keine Mutation, MODE=resume', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  // #272: das ist der Weg, auf dem ein beantwortetes Ticket zurueckkommt --
  // ohne Label-Schreibvorgang, weil 'in-progress' nie abgegeben wurde.
  it('beantwortetes Ticket: kein Umlabeln noetig, MODE=resume (Session bleibt, kein Neustart)', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('Queue-Pick mit role=build: ready->in-progress, MODE=start', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(70, ['ready'])], '#70', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '70', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('Queue-Pick mit role=plan: keine Label-Mutation, MODE=start ohne Session', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(60, ['plan'])], '#60', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 60, role: 'plan', mode: 'start' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('plan-Fallback mit vorhandener Session -> MODE=resume', () => {
    state.write('session-47', 'sess-abc123');
    const gh = ghDouble();
    const outcome = pickTicket([issue(47, ['research'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 47, role: 'research', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('leere Session-Datei zaehlt als keine Session -> MODE=start', () => {
    state.write('session-47', '');
    const gh = ghDouble();
    expect(pickTicket([issue(47, ['research'])], '', gh, state)).toEqual({
      kind: 'ticket',
      issue: 47,
      role: 'research',
      mode: 'start',
    });
  });

  it('ready-Fallback: ready->in-progress, MODE=start', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(48, ['ready'])], '', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 48, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '48', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('#227: ein wartendes hands-off-Ticket wird nicht angefasst', () => {
    const gh = ghDouble();
    expect(pickTicket([issue(156, ['in-progress', 'needs-answer', 'hands-off'])], '', gh, state)).toEqual({
      kind: 'none',
    });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('nichts waehlbar -> none, keine Mutation', () => {
    const gh = ghDouble();
    expect(pickTicket([], '', gh, state)).toEqual({ kind: 'none' });
    expect(gh.run).not.toHaveBeenCalled();
  });
});
