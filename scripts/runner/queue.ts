// Queue-Funktionen, portiert aus claude-runner.sh (#199, S2 von #184). Reine
// Funktionen -- kein `gh`, das Snapshot-JSON kommt als Parameter, genau wie
// auf der Bash-Seite.
//
// #725 (S2 von ADR-0023): der Rang ('Kommt zuerst dran?') ist jetzt das Label
// `next` (select.ts) statt einer Zeilenreihenfolge in einem Queue-Issue. Was
// hier bleibt, ist die zweite Frage aus #92 ('Kommt ueberhaupt dran?') --
// Ketten aus 'Nach:'-Zeilen im TICKET-Body selbst (seit #724), Zirkel, und die
// reine Anzeige-Logik (queuePending/untriaged).

export interface QueueIssue {
  number: number;
  labels: { name: string }[];
  createdAt?: string;
  /** Fuer den Fundschluessel (#366) -- optional, damit kein bestehender Aufrufer bricht. */
  body?: string;
  state?: string;
  stateReason?: string;
}

// Exportiert fuer select.ts (#202 S5) -- dieselbe Label-/Sortierlogik wird
// dort fuer die volle Ticketauswahl-Kaskade (inkl. research) gebraucht.
export function hasLabel(issue: QueueIssue, name: string): boolean {
  return issue.labels.some((label) => label.name === name);
}

export function byCreatedAt(a: QueueIssue, b: QueueIssue): number {
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

// Ein Eintrag der Prioritaets-Queue: das Ticket selbst und die Tickets, die
// vorher fertig sein muessen.
export interface QueueEntry {
  issue: number;
  after: number[];
}

// #724 (S1 von ADR-0023), seit #725 die EINZIGE Quelle: eine Zeile
// 'Nach: #687' im TICKET-Body. Zeilenanker -- Fliesstext ("... laeuft erst
// nach #687") triggert NICHT, dieselbe Vorsicht wie frueher bei der Queue-Zeile
// (#265): ein versehentlich als Kette gelesener Satz wuerde ein Ticket still
// begraben. Mehrere Nummern je Zeile und mehrere 'Nach:'-Zeilen erlaubt,
// Ergebnis dublettenbereinigt in Dokumentreihenfolge.
const AFTER_LINE = /^Nach:(.*)$/gm;

export function parseAfter(body: string): number[] {
  if (!body) return [];
  const after: number[] = [];
  const seen = new Set<number>();
  for (const match of body.matchAll(AFTER_LINE)) {
    for (const raw of match[1].match(/#[0-9]+/g) ?? []) {
      const number = Number(raw.slice(1));
      if (seen.has(number)) continue;
      seen.add(number);
      after.push(number);
    }
  }
  return after;
}

// Ticket-Body-Ketten als QueueEntry[] -- nur Tickets mit mindestens einer
// 'Nach:'-Zeile zaehlen als Eintrag, ein Ticket ohne Kette bleibt ungenannt.
export function entriesFromIssues(snapshot: QueueIssue[]): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const issue of snapshot) {
    const after = parseAfter(issue.body ?? '');
    if (after.length > 0) entries.push({ issue: issue.number, after });
  }
  return entries;
}

// Eine Voraussetzung gilt als erfuellt, sobald ihr Ticket nicht mehr offen ist
// -- beim Merge passiert das ueber 'Closes #' von selbst. Bewertet wird bei
// JEDER Auswahl neu, deshalb kann der Zustand nicht veralten und niemand muss
// nach einem Merge etwas nachlabeln (genau das hat bisher nachweislich nicht
// funktioniert, siehe #265).
//
// Eine Nummer, die es gar nicht gibt, zaehlt ebenfalls als erledigt. Das ist
// Absicht: ein Tippfehler in der Queue darf ein Ticket nicht dauerhaft und
// unsichtbar blockieren.
export function queueBlockers(entry: QueueEntry, openIssues: Set<number>): number[] {
  return entry.after.filter((number) => openIssues.has(number));
}

// Alle wartenden Eintraege: Ticketnummer -> die offenen Voraussetzungen.
export function queueBlocked(entries: QueueEntry[], openIssues: Set<number>): Map<number, number[]> {
  const blocked = new Map<number, number[]>();
  for (const entry of entries) {
    const blockers = queueBlockers(entry, openIssues);
    if (blockers.length > 0) blocked.set(entry.issue, blockers);
  }
  return blocked;
}

// Zirkel innerhalb der Queue. Ohne diese Meldung waere ein Zirkel unsichtbar:
// die beteiligten Tickets blockieren sich gegenseitig, fallen aus der Auswahl
// und nirgends stuende, warum.
//
// Zurueck kommen die beteiligten Ticketnummern aufsteigend, nicht die Kanten.
// Fuer die Meldung reicht "diese Tickets warten aufeinander"; welcher Pfeil
// falsch ist, entscheidet ohnehin ein Mensch.
export function queueCycles(entries: QueueEntry[]): number[] {
  const graph = new Map<number, number[]>(entries.map((entry) => [entry.issue, entry.after]));
  const finished = new Set<number>();
  const involved = new Set<number>();

  const walk = (node: number, path: number[]): void => {
    if (finished.has(node)) return;
    const cycleStart = path.indexOf(node);
    if (cycleStart >= 0) {
      for (const member of path.slice(cycleStart)) involved.add(member);
      return;
    }
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) walk(next, [...path, node]);
    }
    finished.add(node);
  };

  for (const entry of entries) walk(entry.issue, []);
  return [...involved].sort((a, b) => a - b);
}

// Offene Queue-Arbeit als "#a, #b" (leer = nichts offen): ready|plan|
// research, jeweils OHNE das Wartelabel.
//
// Das ist bewusst NICHT dieselbe Frage wie `queueNext()`: hier zaehlt, was
// offen ist, dort, was der Runner als naechstes naehme. Ein 'hands-off'-Ticket
// bleibt deshalb hier sichtbar -- es ist offene Arbeit, nur eben keine fuer
// den Runner (#271 AC3).
//
// #272: das Wartelabel hiess bis S2b 'needs-input'. Der Filter meinte immer
// schon "wartet auf den Menschen"; nur der Name hat sich geaendert.
export function queuePending(snapshot: QueueIssue[]): string {
  return snapshot
    .filter((issue) => {
      const eligible =
        hasLabel(issue, 'ready') || hasLabel(issue, 'plan') || hasLabel(issue, 'research');
      return eligible && !hasLabel(issue, 'needs-answer');
    })
    .map((issue) => issue.number)
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(', ');
}

// #271: Hier stand bis heute eine zweite, von Hand gepflegte Kopie der
// Auswahl-Kaskade. Sie ist nach select.ts gewandert und dort ein Dreizeiler
// ueber `selectTicket()` -- die Anzeige im Status-Issue kann strukturell nicht
// mehr etwas anderes sagen als das, was der Runner dann baut.
//
// Der Beweis, dass die Kopie driftet, steht in der Ticket-Historie: 'hands-off'
// fehlte hier in zwei Zweigen, 'resume-parked' fehlte ganz, und zuletzt filterte
// sie noch 'needs-input' -- ein Label, das es seit S2b nicht mehr gibt.

// #357: die Steuerlabel, die ein offenes Issue aus dem "untriagiert"-Bericht
// nehmen. Exportiert, damit ein Test die Menge 1:1 gegen die Owner-Entscheidung
// (29.07.26, "C") festnageln kann -- bewusst eine eigene Liste, NICHT dieselbe
// wie BLOCKING_LABELS in select.ts (das ist die Auswahl-Sperre, dies die
// Triage-Sichtbarkeit; ein Zusammenlegen beschaedigte beide Fragen).
// #725 (AK7): 'next' dazu -- ein Ticket mit `next` ist triagiert, genau wie
// eins mit `ready`/`plan`/`research`.
export const TRIAGE_LABELS = [
  'in-progress',
  'next',
  'plan',
  'research',
  'ready',
  'needs-answer',
  'hands-off',
] as const;

// Offene Issues ohne jedes Steuerlabel -- der untriagierte Eingang aus der
// Owner-Entscheidung zu #357. `metaIssues` schliesst das Status-Issue selbst
// aus: es ist offen und traegt kein Steuerlabel, waere also ohne den
// Ausschluss jeden Takt faelschlich als "untriagiert" gemeldet. Gebaut wird
// davon nichts -- nur sichtbar gemacht, damit ein ausgelagertes Fund-Ticket
// nicht mehr still verrottet.
//
// #725 (AK8): der Parameter `entries` ("gelistet in der Queue?") ist mit dem
// Queue-Issue selbst weg -- es gibt keine Liste mehr, an der ein Ticket
// gelistet sein koennte. Ein Ticket mit einer 'Nach:'-Zeile im eigenen Body,
// aber ohne Steuerlabel, gilt deshalb bewusst weiterhin als untriagiert.
export function untriaged(snapshot: QueueIssue[], metaIssues: ReadonlySet<number>): number[] {
  return snapshot
    .filter((issue) => !metaIssues.has(issue.number) && !TRIAGE_LABELS.some((label) => hasLabel(issue, label)))
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

// #366: der Fundschluessel macht ein Fund-Ticket ueber den Testort statt der
// Hypothese wiederfindbar -- Titel wechseln je Lauf ("flaky(nav): ...",
// "e2e: aktivitaeten.spec.ts AC6 ..."), der Schluessel im Body nicht.
//
// Zeilenanker (multiline 'm'), damit Fliesstext ("... siehe Fund: irgendwo")
// nicht triggert -- dieselbe Vorsicht wie bei AFTER_LINE oben. #410 R1/AK1:
// globales Flag statt nur der ersten Zeile -- ein Ticket, das dieselbe
// Ursache in mehreren roten Tests belegt, traegt mehrere 'Fund:'-Zeilen.
// #588: Hier lagen 'parseFindKeys', 'foundTickets' und 'findFoundTicket' --
// der Dedupe-Apparat hinter den Fund-Tickets (Fundschluessel 'Fund: <pfad>:
// <zeile>' aus dem Ticket-Body lesen, das aelteste Ticket je Schluessel
// finden, die Liste in den Prompt rendern). Der Runner legt keine
// Fund-Tickets mehr an, also gibt es nichts mehr zu deduplizieren.
//
// Bestehende Tickets mit einer 'Fund:'-Zeile im Body bleiben davon unberuehrt
// -- sie sind ganz normale Tickets, die Zeile ist ab jetzt nur noch Text.
