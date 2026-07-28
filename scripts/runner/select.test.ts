import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import { createStateAdapter, type StateAdapter } from './state';
import { pickTicket, queueNext, selectTicket } from './select';
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
    expect(selectTicket(snapshot, '- #50\n- #60')).toEqual({ issue: 60, role: 'build', source: 'queue' });
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
    expect(selectTicket(snapshot, '- #99')).toEqual({ issue: 99, role: 'build', source: 'queue' });
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
    expect(selectTicket(snapshot, '- #50\n- #60')?.issue).toBe(60);
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
    const outcome = pickTicket([issue(70, ['ready'])], '- #70', gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '70', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('Queue-Pick mit role=plan: keine Label-Mutation, MODE=start ohne Session', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(60, ['plan'])], '- #60', gh, state);
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

// --- #271: die Anzeige IST die Auswahl -------------------------------------
// `queueNext()` beantwortet fuers Status-Issue "welches Ticket naehme der
// Runner als naechstes". Bis #271 war das eine zweite Kaskade in queue.ts, die
// dreimal nachweislich abdriftete (hands-off fehlte in zwei Zweigen,
// resume-parked fehlte ganz, zuletzt filterte sie das abgeschaffte
// 'needs-input'). Die folgenden Faelle standen bis heute in queue.test.ts --
// sie gelten unveraendert weiter, pruefen jetzt aber dieselbe Kaskade.
describe('queueNext (Anzeige im Status-Issue)', () => {
  const q = (number: number, labels: string[], createdAt?: string): QueueIssue => issue(number, labels, createdAt ?? '2024-01-01T00:00:00Z');

  it('picks a running in-progress ticket over plan and ready', () => {
    expect(queueNext([q(10, ['ready']), q(20, ['plan']), q(30, ['in-progress'])])).toBe(30);
  });

  it('skips a ticket that waits on the human, falling back to the next ready one', () => {
    expect(queueNext([q(40, ['ready', 'needs-answer']), q(41, ['ready'])])).toBe(41);
  });

  it('skips a hands-off plan ticket, falling back to ready', () => {
    expect(queueNext([q(50, ['plan', 'hands-off']), q(51, ['ready'])])).toBe(51);
  });

  it('skips a hands-off in-progress ticket, falling back to ready', () => {
    expect(queueNext([q(52, ['in-progress', 'hands-off']), q(53, ['ready'])])).toBe(53);
  });

  it('skips a hands-off ready ticket, falling back to the next ready one', () => {
    expect(queueNext([q(54, ['ready', 'hands-off']), q(55, ['ready'], '2024-01-02T00:00:00Z')])).toBe(55);
  });

  it('returns null when every ticket carries hands-off', () => {
    expect(
      queueNext([q(56, ['in-progress', 'hands-off']), q(57, ['plan', 'hands-off']), q(58, ['ready', 'hands-off'])]),
    ).toBeNull();
  });

  // Der einzige Fall, in dem sich die Antwort mit #271 AENDERT -- und zwar zur
  // richtigen hin: die alte Kopie kannte den research-Zweig ueberhaupt nicht
  // und meldete "nichts steht an", waehrend der Runner im naechsten Takt genau
  // dieses Ticket nahm. Genau diese Sorte Luege soll das Ticket abstellen.
  it('names an open research ticket -- the runner takes it next', () => {
    expect(queueNext([q(60, ['research'])])).toBe(60);
  });

  it('returns null for an empty queue', () => {
    expect(queueNext([q(70, [])])).toBeNull();
  });

  it('picks the oldest ticket within a stage by createdAt, not array order', () => {
    expect(queueNext([q(82, ['ready'], '2024-06-01T00:00:00Z'), q(81, ['ready'])])).toBe(81);
  });

  it('listed ticket without any label still wins (label is irrelevant for the flat queue)', () => {
    expect(queueNext([q(77, [])], '- #77')).toBe(77);
  });

  it('queue order beats createdAt', () => {
    expect(queueNext([q(10, []), q(99, [], '2024-06-01T00:00:00Z')], '- #99\n- #10')).toBe(99);
  });

  it('a listed ticket beats an unlisted ready one', () => {
    expect(queueNext([q(10, ['ready']), q(99, [], '2024-06-01T00:00:00Z')], '- #99')).toBe(99);
  });

  it('a waiting listed ticket falls back to the plain queue/label logic', () => {
    expect(queueNext([q(77, ['needs-answer']), q(88, ['ready'], '2024-02-01T00:00:00Z')], '- #77')).toBe(88);
  });

  it('hands-off excludes a listed ticket, falling back to the plain queue/label logic', () => {
    expect(queueNext([q(77, ['hands-off']), q(88, ['ready'], '2024-02-01T00:00:00Z')], '- #77')).toBe(88);
  });

  it('empty queue body falls back to ready by oldest createdAt', () => {
    expect(queueNext([q(10, ['ready']), q(99, ['ready'], '2024-06-01T00:00:00Z')], '')).toBe(10);
  });
});

// #271 AC1/AC2: der eigentliche Zwang. Solange `queueNext()` an
// `selectTicket()` delegiert, kann das hier gar nicht scheitern -- das ist der
// Punkt. Wuerde jemand die Kaskade dort wieder auseinanderziehen (oder eine
// zweite Kopie anlegen), faellt genau dieser Test um, und zwar in dem Fall, in
// dem die beiden auseinanderlaufen.
describe('Paritaet queueNext <-> selectTicket (#271)', () => {
  const faelle: { name: string; snapshot: QueueIssue[]; body?: string }[] = [
    { name: 'leerer Snapshot', snapshot: [] },
    { name: 'nur ein ready-Ticket', snapshot: [issue(10, ['ready'])] },
    {
      name: 'laufendes Ticket schlaegt ready',
      snapshot: [issue(10, ['ready']), issue(20, ['in-progress'])],
    },
    {
      name: 'laufendes Ticket wartet auf eine Antwort',
      snapshot: [issue(20, ['in-progress', 'needs-answer']), issue(10, ['ready'])],
    },
    {
      name: 'hands-off auf jedem Zweig',
      snapshot: [
        issue(20, ['in-progress', 'hands-off']),
        issue(30, ['plan', 'hands-off']),
        issue(40, ['ready', 'hands-off']),
      ],
    },
    {
      name: 'Queue-Reihenfolge schlaegt die Label-Kaskade',
      snapshot: [issue(10, ['ready']), issue(99, [], '2024-06-01T00:00:00Z')],
      body: '- #99\n- #10',
    },
    {
      name: 'gelistetes Ticket wartet -- Rueckfall auf die Label-Kaskade',
      snapshot: [issue(77, ['needs-answer']), issue(88, ['ready'], '2024-02-01T00:00:00Z')],
      body: '- #77',
    },
    { name: 'plan vor research', snapshot: [issue(30, ['research']), issue(40, ['plan'])] },
    { name: 'nur research offen', snapshot: [issue(60, ['research'])] },
    {
      name: 'research UND ready am selben Ticket',
      snapshot: [issue(60, ['research', 'ready'])],
    },
    { name: 'alles wartet', snapshot: [issue(50, ['in-progress', 'needs-answer']), issue(60, ['ready', 'needs-answer'])] },
  ];

  it.each(faelle)('$name', ({ snapshot, body }) => {
    expect(queueNext(snapshot, body ?? '')).toBe(selectTicket(snapshot, body ?? '')?.issue ?? null);
  });

  it('gilt auch fuer die Rolle -- die Anzeige nennt das Ticket, das gebaut ODER gedacht wird', () => {
    const snapshot = [issue(30, ['research']), issue(40, ['plan'])];
    const selected = selectTicket(snapshot);
    expect(selected?.role).toBe('plan');
    expect(queueNext(snapshot)).toBe(selected?.issue);
  });
});

// --- #265: Abhaengigkeiten aus der Queue ------------------------------------
// "ready, sobald #239 gemerged ist" stand bisher als Prosa im Ticket und
// verlangte nach jedem Merge eine Handlung vom Menschen. Das hat nachweislich
// nicht funktioniert (#241, #243, #266 warteten genau darauf, nach dem Merge
// von #97 stand die Queue leer, obwohl Arbeit dalag). Jetzt ist es eine
// Angabe in der Queue-Zeile, die bei JEDER Auswahl neu bewertet wird.
describe('Abhaengigkeiten in der Queue (#265)', () => {
  it('AC4: eine offene Voraussetzung haelt das Ticket aus der Auswahl', () => {
    const snapshot = [issue(266, ['ready']), issue(227, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #266 nach #227')).toEqual({
      issue: 227,
      role: 'build',
      source: 'ready',
    });
  });

  it('AC5: ist die Voraussetzung geschlossen, ist das Ticket sofort waehlbar -- ohne Label-Handgriff', () => {
    // #227 ist geschlossen und steht deshalb nicht mehr im Snapshot.
    expect(selectTicket([issue(266, ['ready'])], '- #266 nach #227')).toEqual({
      issue: 266,
      role: 'build',
      source: 'queue',
    });
  });

  // Die Sperre gehoert zentral vor die Kaskade, nicht in den Queue-Zweig:
  // sonst rutscht dasselbe Ticket ueber den ready- oder plan-Zweig herein.
  it('ein blockiertes Ticket kommt auch nicht ueber den ready-Zweig herein', () => {
    const snapshot = [issue(266, ['ready']), issue(227, ['hands-off'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #266 nach #227')).toBeNull();
  });

  it('ein blockiertes plan-Ticket wird auch nicht geplant', () => {
    const snapshot = [issue(266, ['plan']), issue(227, ['needs-answer'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #266 nach #227')).toBeNull();
  });

  it('AC6: bei einem Zirkel wird keins der beteiligten Tickets gebaut', () => {
    const snapshot = [issue(1, ['ready']), issue(2, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #1 nach #2\n- #2 nach #1')).toBeNull();
  });

  it('AC3: eine Notizzeile mit einer Raute reiht kein Ticket ein', () => {
    const snapshot = [issue(156, []), issue(266, ['ready'], '2024-02-01T00:00:00Z')];
    // #156 taucht nur in der Notiz auf -- ohne die Regel waere es Rang 2 und
    // haette als gelistetes Ticket Vorrang vor jedem ready-Ticket.
    expect(selectTicket(snapshot, '- #266\n\n> Notiz: siehe #156')).toEqual({
      issue: 266,
      role: 'build',
      source: 'queue',
    });
  });

  it('mehrere Voraussetzungen: eine offene genuegt zum Blockieren', () => {
    const snapshot = [issue(266, ['ready']), issue(225, ['ready'], '2024-03-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #266 nach #227 #225')?.issue).toBe(225);
  });
});

// #204: mehrere Slots duerfen sich nicht gegenseitig Tickets wegnehmen.
describe('claimedElsewhere (#204) -- ohne den Snapshot fuer Abhaengigkeiten zu verfaelschen', () => {
  it('ein von einem anderen Slot beanspruchtes Ticket wird uebersprungen, das naechste gewaehlt', () => {
    const snapshot = [issue(70, ['ready']), issue(80, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '', new Set([70]))).toEqual({ issue: 80, role: 'build', source: 'ready' });
  });

  it('sind alle Tickets anderswo beansprucht, waehlt der Slot nichts', () => {
    const snapshot = [issue(70, ['ready'])];
    expect(selectTicket(snapshot, '', new Set([70]))).toBeNull();
  });

  // Der eigentliche Grund, warum claimedElsewhere NICHT aus dem Snapshot
  // entfernt werden darf, bevor queueBlocked ihn sieht: #227 ist noch offen
  // und wird von einem anderen Slot gebaut. Ein einfacher claimFilter() auf
  // dem ganzen Snapshot haette #227 verschwinden lassen -- die Abhaengigkeit
  // von #266 waere faelschlich als erledigt gegolten.
  it('ein von einem anderen Slot beanspruchter BLOCKER haelt das abhaengige Ticket weiterhin zurueck', () => {
    const snapshot = [issue(266, ['ready']), issue(227, ['in-progress'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, '- #266 nach #227', new Set([227]))).toBeNull();
  });

  it('pickTicket reicht claimedElsewhere durch', () => {
    const gh: GhAdapter = { run: vi.fn().mockReturnValue('') };
    const dir = mkdtempSync(join(tmpdir(), 'pick-claim-'));
    const state = createStateAdapter(dir);
    const snapshot = [issue(70, ['ready']), issue(80, ['ready'], '2024-02-01T00:00:00Z')];
    const result = pickTicket(snapshot, '', gh, state, new Set([70]));
    expect(result).toEqual({ kind: 'ticket', issue: 80, role: 'build', mode: 'start' });
    rmSync(dir, { recursive: true, force: true });
  });
});
