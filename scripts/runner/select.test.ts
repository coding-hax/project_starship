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

function issue(number: number, labels: string[], createdAt = '2024-01-01T00:00:00Z', body?: string): QueueIssue {
  return { number, labels: label(...labels), createdAt, ...(body !== undefined ? { body } : {}) };
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

  // #725 (S2 von ADR-0023): der Rang ist jetzt das Label `next`, nicht mehr
  // eine Zeilenreihenfolge im Queue-Issue-Body.
  it('needs-answer schlaegt next -- das naechste next-Ticket kommt dran', () => {
    const snapshot = [issue(50, ['next', 'needs-answer']), issue(60, ['next'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 60, role: 'build', source: 'next' });
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

  it('next schlaegt die Label-Kaskade, das Rollen-Label ist fuer den Rang egal', () => {
    const snapshot = [issue(10, ['ready']), issue(99, ['next'])];
    expect(selectTicket(snapshot)).toEqual({ issue: 99, role: 'build', source: 'next' });
  });

  it('plan hat Vorrang vor research, auch bei niedrigerer Nummer (Fallback ohne next)', () => {
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

  it('next waehlt nach createdAt, nicht nach Issue-Nummer', () => {
    const snapshot = [issue(99, ['next'], '2024-01-01T00:00:00Z'), issue(10, ['next'], '2024-06-01T00:00:00Z')];
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

  it('hands-off schlaegt next -- das naechste next-Ticket kommt dran', () => {
    const snapshot = [issue(50, ['next', 'hands-off']), issue(60, ['next'])];
    expect(selectTicket(snapshot)?.issue).toBe(60);
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
    const outcome = pickTicket([issue(50, ['in-progress', 'needs-answer']), issue(70, ['ready'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
  });

  it('wartet alles auf eine Antwort, passiert gar nichts', () => {
    const gh = ghDouble();
    expect(pickTicket([issue(50, ['in-progress', 'needs-answer'])], gh, state)).toEqual({ kind: 'none' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('laufendes Ticket: keine Mutation, MODE=resume', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  // #272: das ist der Weg, auf dem ein beantwortetes Ticket zurueckkommt --
  // ohne Label-Schreibvorgang, weil 'in-progress' nie abgegeben wurde.
  it('beantwortetes Ticket: kein Umlabeln noetig, MODE=resume (Session bleibt, kein Neustart)', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(50, ['in-progress'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 50, role: 'build', mode: 'resume' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  // #725 AK3: 'next' faellt beim Start eines Bau-Laufs NICHT weg -- nur
  // 'ready' wird abgenommen.
  it('next-Pick mit role=build: ready->in-progress, MODE=start, next bleibt stehen', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(70, ['next', 'ready'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 70, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '70', '--add-label', 'in-progress', '--remove-label', 'ready']);
    expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining(['--remove-label', 'next']));
  });

  it('next-Pick mit role=plan: in-progress dazu (ready bleibt unberuehrt), MODE=start ohne Session', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(60, ['next', 'plan'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 60, role: 'plan', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '60', '--add-label', 'in-progress']);
    expect(gh.run).toHaveBeenCalledTimes(1);
  });

  it('plan-Fallback mit vorhandener Session -> MODE=resume, in-progress dazu (#387 AC1)', () => {
    state.write('session-think-47', 'sess-abc123');
    const gh = ghDouble();
    const outcome = pickTicket([issue(47, ['research'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 47, role: 'research', mode: 'resume' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '47', '--add-label', 'in-progress']);
  });

  it('leere Session-Datei zaehlt als keine Session -> MODE=start', () => {
    state.write('session-think-47', '');
    const gh = ghDouble();
    expect(pickTicket([issue(47, ['research'])], gh, state)).toEqual({
      kind: 'ticket',
      issue: 47,
      role: 'research',
      mode: 'start',
    });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '47', '--add-label', 'in-progress']);
  });

  it('ready-Fallback: ready->in-progress, MODE=start', () => {
    const gh = ghDouble();
    const outcome = pickTicket([issue(48, ['ready'])], gh, state);
    expect(outcome).toEqual({ kind: 'ticket', issue: 48, role: 'build', mode: 'start' });
    expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '48', '--add-label', 'in-progress', '--remove-label', 'ready']);
  });

  it('#227: ein wartendes hands-off-Ticket wird nicht angefasst', () => {
    const gh = ghDouble();
    expect(pickTicket([issue(156, ['in-progress', 'needs-answer', 'hands-off'])], gh, state)).toEqual({
      kind: 'none',
    });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('nichts waehlbar -> none, keine Mutation', () => {
    const gh = ghDouble();
    expect(pickTicket([], gh, state)).toEqual({ kind: 'none' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  // #387: Denk-Laeufe (plan/research) tragen in-progress, solange sie laufen,
  // und werden beim Fortsetzen als Denk-Lauf erkannt -- nicht als Bau-Lauf.
  describe('Denk-Laeufe tragen in-progress (#387)', () => {
    it('AC1: ein plan-Fallback-Treffer bekommt in-progress dazu, ready bliebe unberuehrt (waere es gesetzt)', () => {
      const gh = ghDouble();
      const outcome = pickTicket([issue(91, ['plan', 'ready'])], gh, state);
      expect(outcome).toEqual({ kind: 'ticket', issue: 91, role: 'plan', mode: 'start' });
      expect(gh.run).toHaveBeenCalledWith(['issue', 'edit', '91', '--add-label', 'in-progress']);
      expect(gh.run).not.toHaveBeenCalledWith(expect.arrayContaining(['--remove-label']));
    });

    it('AC2: selectTicket liest die Rolle eines laufenden Denk-Tickets aus den Labels, nicht hart build', () => {
      expect(selectTicket([issue(91, ['in-progress', 'plan'])])).toEqual({ issue: 91, role: 'plan', source: 'running' });
      expect(selectTicket([issue(92, ['in-progress', 'research'])])).toEqual({
        issue: 92,
        role: 'research',
        source: 'running',
      });
    });

    it('AC2: pickTicket running-case reicht die Denk-Rolle durch, ohne erneut zu labeln', () => {
      state.write('session-think-91', 'sess-plan-1');
      const gh = ghDouble();
      const outcome = pickTicket([issue(91, ['in-progress', 'plan'])], gh, state);
      expect(outcome).toEqual({ kind: 'ticket', issue: 91, role: 'plan', mode: 'resume' });
      expect(gh.run).not.toHaveBeenCalled();
    });

    it('AC2: fehlt die Denk-Session beim laufenden Ticket, ist MODE=start statt resume', () => {
      const gh = ghDouble();
      const outcome = pickTicket([issue(92, ['in-progress', 'research'])], gh, state);
      expect(outcome).toEqual({ kind: 'ticket', issue: 92, role: 'research', mode: 'start' });
      expect(gh.run).not.toHaveBeenCalled();
    });

    it('ein laufendes Bau-Ticket bleibt unveraendert build/resume', () => {
      const gh = ghDouble();
      const outcome = pickTicket([issue(93, ['in-progress'])], gh, state);
      expect(outcome).toEqual({ kind: 'ticket', issue: 93, role: 'build', mode: 'resume' });
      expect(gh.run).not.toHaveBeenCalled();
    });
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

  // #725: der Rang ist jetzt das Label `next` -- ein `next`-Ticket ohne
  // jedes Rollenlabel gewinnt trotzdem (build ist der Default).
  it('a next ticket without any role label still wins (role is irrelevant for the rank)', () => {
    expect(queueNext([q(77, ['next'])])).toBe(77);
  });

  it('among multiple next tickets, the oldest createdAt wins regardless of array order', () => {
    expect(queueNext([q(10, ['next'], '2024-06-01T00:00:00Z'), q(99, ['next'])])).toBe(99);
  });

  it('a next ticket beats an unlisted ready one', () => {
    expect(queueNext([q(10, ['ready']), q(99, ['next'], '2024-06-01T00:00:00Z')])).toBe(99);
  });

  it('a waiting next ticket falls back to the plain label logic', () => {
    expect(queueNext([q(77, ['next', 'needs-answer']), q(88, ['ready'], '2024-02-01T00:00:00Z')])).toBe(88);
  });

  it('hands-off excludes a next ticket, falling back to the plain label logic', () => {
    expect(queueNext([q(77, ['next', 'hands-off']), q(88, ['ready'], '2024-02-01T00:00:00Z')])).toBe(88);
  });

  it('no next ticket falls back to ready by oldest createdAt', () => {
    expect(queueNext([q(10, ['ready']), q(99, ['ready'], '2024-06-01T00:00:00Z')])).toBe(10);
  });
});

// #271 AC1/AC2: der eigentliche Zwang. Solange `queueNext()` an
// `selectTicket()` delegiert, kann das hier gar nicht scheitern -- das ist der
// Punkt. Wuerde jemand die Kaskade dort wieder auseinanderziehen (oder eine
// zweite Kopie anlegen), faellt genau dieser Test um, und zwar in dem Fall, in
// dem die beiden auseinanderlaufen.
describe('Paritaet queueNext <-> selectTicket (#271)', () => {
  const faelle: { name: string; snapshot: QueueIssue[] }[] = [
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
      name: 'next schlaegt die Label-Kaskade',
      snapshot: [issue(10, ['ready']), issue(99, ['next'], '2024-06-01T00:00:00Z')],
    },
    {
      name: 'next-Ticket wartet -- Rueckfall auf die Label-Kaskade',
      snapshot: [issue(77, ['next', 'needs-answer']), issue(88, ['ready'], '2024-02-01T00:00:00Z')],
    },
    { name: 'plan vor research', snapshot: [issue(30, ['research']), issue(40, ['plan'])] },
    { name: 'nur research offen', snapshot: [issue(60, ['research'])] },
    {
      name: 'research UND ready am selben Ticket',
      snapshot: [issue(60, ['research', 'ready'])],
    },
    { name: 'alles wartet', snapshot: [issue(50, ['in-progress', 'needs-answer']), issue(60, ['ready', 'needs-answer'])] },
  ];

  it.each(faelle)('$name', ({ snapshot }) => {
    expect(queueNext(snapshot)).toBe(selectTicket(snapshot)?.issue ?? null);
  });

  it('gilt auch fuer die Rolle -- die Anzeige nennt das Ticket, das gebaut ODER gedacht wird', () => {
    const snapshot = [issue(30, ['research']), issue(40, ['plan'])];
    const selected = selectTicket(snapshot);
    expect(selected?.role).toBe('plan');
    expect(queueNext(snapshot)).toBe(selected?.issue);
  });
});

// #724 (S1 von ADR-0023), seit #725 die EINZIGE Quelle: die Kette steht als
// 'Nach: #687'-Zeile im TICKET-Body. Der Rang selbst ('- #NN' im
// Queue-Issue-Body aus #265) ist mit dem Queue-Issue komplett weg -- siehe
// select.test.ts, describe('selectTicket ...') und queueNext oben fuer den
// Rang, hier bleibt nur das Blockieren.
describe('Abhaengigkeiten aus dem Ticket-Body (#724/#725)', () => {
  it('eine "Nach:"-Zeile im eigenen Body haelt ein ready-Ticket aus der Auswahl', () => {
    const snapshot = [issue(266, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #227'), issue(227, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot)).toEqual({ issue: 227, role: 'build', source: 'ready' });
  });

  it('dieselbe Sperre gilt auch auf dem in-progress-Zweig -- zentral vor allen Zweigen', () => {
    const snapshot = [issue(266, ['in-progress'], '2024-01-01T00:00:00Z', 'Nach: #227'), issue(227, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot)).toEqual({ issue: 227, role: 'build', source: 'ready' });
  });

  it('faellt die Voraussetzung weg (ihr Ticket nicht mehr offen), ist das Ticket sofort waehlbar', () => {
    expect(selectTicket([issue(266, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #227')])).toEqual({
      issue: 266,
      role: 'build',
      source: 'ready',
    });
  });

  it('eine Ticket-Body-Kette macht kein Ticket zum next-Kandidaten -- next bleibt ein eigenes Label', () => {
    // #50 traegt selbst eine (laengst erfuellte) 'Nach:'-Zeile, aber kein
    // 'next'-Label. Waere die Kette selbst schon ein Rang-Signal, gewaenne
    // #50 faelschlich den 'next'-Zweig -- er darf nur ueber 'ready' laufen.
    const snapshot = [issue(50, ['ready'], '2024-06-01T00:00:00Z', 'Nach: #1'), issue(10, ['ready'], '2024-01-01T00:00:00Z')];
    expect(selectTicket(snapshot)).toEqual({ issue: 10, role: 'build', source: 'ready' });
  });

  // Die Sperre gehoert zentral vor die Kaskade, nicht in den next-Zweig: sonst
  // rutscht dasselbe Ticket ueber den ready- oder plan-Zweig herein.
  it('ein blockiertes Ticket kommt auch nicht ueber den ready-Zweig herein, selbst wenn sein Blocker hands-off traegt', () => {
    const snapshot = [issue(266, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #227'), issue(227, ['hands-off'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot)).toBeNull();
  });

  it('ein blockiertes plan-Ticket wird auch nicht geplant', () => {
    const snapshot = [issue(266, ['plan'], '2024-01-01T00:00:00Z', 'Nach: #227'), issue(227, ['needs-answer'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot)).toBeNull();
  });

  it('bei einem Zirkel wird keins der beteiligten Tickets gebaut', () => {
    const snapshot = [
      issue(1, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #2'),
      issue(2, ['ready'], '2024-02-01T00:00:00Z', 'Nach: #1'),
    ];
    expect(selectTicket(snapshot)).toBeNull();
  });

  it('mehrere Voraussetzungen: eine offene genuegt zum Blockieren', () => {
    const snapshot = [
      issue(266, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #227 #225'),
      issue(225, ['ready'], '2024-03-01T00:00:00Z'),
    ];
    expect(selectTicket(snapshot)?.issue).toBe(225);
  });
});

// #204: mehrere Slots duerfen sich nicht gegenseitig Tickets wegnehmen.
describe('claimedElsewhere (#204) -- ohne den Snapshot fuer Abhaengigkeiten zu verfaelschen', () => {
  it('ein von einem anderen Slot beanspruchtes Ticket wird uebersprungen, das naechste gewaehlt', () => {
    const snapshot = [issue(70, ['ready']), issue(80, ['ready'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, new Set([70]))).toEqual({ issue: 80, role: 'build', source: 'ready' });
  });

  it('sind alle Tickets anderswo beansprucht, waehlt der Slot nichts', () => {
    const snapshot = [issue(70, ['ready'])];
    expect(selectTicket(snapshot, new Set([70]))).toBeNull();
  });

  // Der eigentliche Grund, warum claimedElsewhere NICHT aus dem Snapshot
  // entfernt werden darf, bevor queueBlocked ihn sieht: #227 ist noch offen
  // und wird von einem anderen Slot gebaut. Ein einfacher claimFilter() auf
  // dem ganzen Snapshot haette #227 verschwinden lassen -- die Abhaengigkeit
  // von #266 waere faelschlich als erledigt gegolten.
  it('ein von einem anderen Slot beanspruchter BLOCKER haelt das abhaengige Ticket weiterhin zurueck', () => {
    const snapshot = [issue(266, ['ready'], '2024-01-01T00:00:00Z', 'Nach: #227'), issue(227, ['in-progress'], '2024-02-01T00:00:00Z')];
    expect(selectTicket(snapshot, new Set([227]))).toBeNull();
  });

  it('pickTicket reicht claimedElsewhere durch', () => {
    const gh: GhAdapter = { run: vi.fn().mockReturnValue('') };
    const dir = mkdtempSync(join(tmpdir(), 'pick-claim-'));
    const state = createStateAdapter(dir);
    const snapshot = [issue(70, ['ready']), issue(80, ['ready'], '2024-02-01T00:00:00Z')];
    const result = pickTicket(snapshot, gh, state, new Set([70]));
    expect(result).toEqual({ kind: 'ticket', issue: 80, role: 'build', mode: 'start' });
    rmSync(dir, { recursive: true, force: true });
  });
});
