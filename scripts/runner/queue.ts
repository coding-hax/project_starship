// Prioritaets-Queue-Funktionen, portiert aus claude-runner.sh (#199, S2 von
// #184). Reine Funktionen -- kein `gh`, das Snapshot-JSON und der Queue-Body
// kommen als Parameter, genau wie auf der Bash-Seite.
//
// Leseregel seit #265 (S3 von #264): nur Zeilen, die mit '- #' beginnen,
// zaehlen als Eintrag; die erste Nummer ist das Ticket, weitere Nummern
// derselben Zeile sind Voraussetzungen. Bis dahin zaehlte jede Raute-Nummer im
// Body -- auch die in Notizen (#199 Nicht-Ziele).

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

// Was als Eintrag zaehlt: '- #266 nach #227 #225', und zwar genau am
// Zeilenanfang. Eingeruecktes zaehlt NICHT -- damit laesst sich das Format im
// Queue-Issue selbst dokumentieren, ohne dass die Beispiele zu Bauanweisungen
// werden. (Genau das ist beim Umschreiben von Issue 92 passiert: die Vorlage
// zum Kopieren stand als eingerueckte Liste da und haette drei Tickets
// eingereiht.)
//
// Die Richtung des Irrtums ist Absicht: ein versehentlich eingerueckter
// Eintrag wird NICHT gebaut, und das faellt auf -- der Status meldet das
// Ticket dann als nicht gelistetes 'ready' oder gar nichts zu tun. Umgekehrt
// waere ein versehentlich gebautes Ticket erst sichtbar, wenn ein PR steht.
const ENTRY_LINE = /^-\s+#([0-9]+)(.*)$/;

// Body-Text -> Eintraege in Dokumentreihenfolge, dublettenbereinigt.
//
// #265: Bis hierher zaehlte JEDE Raute-Nummer im Body -- auch die in Notizen.
// Deshalb stand in Issue 92 die Warnung, in Fliesstext keine Rauten zu
// benutzen: eine Fussangel, die nur haelt, solange jemand daran denkt, und die
// bei Missachtung still ein fremdes Ticket einreiht. Jetzt zaehlt eine Zeile
// nur als Eintrag, wenn sie mit '- #' beginnt; Notizen duerfen wieder normale
// Ticketnummern enthalten.
//
// Die erste Nummer der Zeile ist der Eintrag, jede weitere eine Voraussetzung.
// Das Wort dazwischen ('nach') ist reine Lesbarkeit und wird NICHT geparst --
// sonst wuerde ein hingeschriebenes 'vor' stillschweigend das Gegenteil
// bedeuten.
export function queueEntries(body: string): QueueEntry[] {
  if (!body) return [];
  const entries: QueueEntry[] = [];
  const seen = new Set<number>();
  for (const line of body.split('\n')) {
    const match = ENTRY_LINE.exec(line);
    if (!match) continue;
    const issue = Number(match[1]);
    if (seen.has(issue)) continue;
    seen.add(issue);
    const after = (match[2].match(/#[0-9]+/g) ?? []).map((raw) => Number(raw.slice(1)));
    entries.push({ issue, after: [...new Set(after)] });
  }
  return entries;
}

// Nur die Reihenfolge, ohne Abhaengigkeiten -- der Rang eines Tickets in der
// Liste. Die Auswahl braucht beides getrennt: der Rang bestimmt, WER zuerst
// drankommt, die Abhaengigkeit, OB ueberhaupt.
export function queueOrderFlat(body: string): number[] {
  return queueEntries(body).map((entry) => entry.issue);
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

// Eintraege, deren Ticket nicht mehr offen ist -- erledigt, aber noch gelistet.
// Der Runner schreibt Issue 92 NICHT um (Entscheidung vom 27.07.26): die Liste
// bleibt die des Menschen, der Status weist nur aus, was gestrichen werden kann.
export function queueDone(entries: QueueEntry[], openIssues: Set<number>): number[] {
  return entries.filter((entry) => !openIssues.has(entry.issue)).map((entry) => entry.issue);
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
export const TRIAGE_LABELS = [
  'in-progress',
  'plan',
  'research',
  'ready',
  'needs-answer',
  'hands-off',
] as const;

// Offene Issues ohne jedes Steuerlabel, die auch nicht in der Queue stehen --
// der untriagierte Eingang aus der Owner-Entscheidung zu #357. `metaIssues`
// schliesst Status- und Queue-Issue selbst aus: beide sind offen und tragen
// kein Steuerlabel, waeren also ohne den Ausschluss jeden Takt faelschlich
// als "untriagiert" gemeldet. Gebaut wird davon nichts -- nur sichtbar
// gemacht, damit ein ausgelagertes Fund-Ticket nicht mehr still verrottet.
export function untriaged(
  snapshot: QueueIssue[],
  entries: QueueEntry[],
  metaIssues: ReadonlySet<number>,
): number[] {
  const listed = new Set(entries.map((entry) => entry.issue));
  return snapshot
    .filter(
      (issue) =>
        !metaIssues.has(issue.number) &&
        !listed.has(issue.number) &&
        !TRIAGE_LABELS.some((label) => hasLabel(issue, label)),
    )
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

// #366: der Fundschluessel macht ein Fund-Ticket ueber den Testort statt der
// Hypothese wiederfindbar -- Titel wechseln je Lauf ("flaky(nav): ...",
// "e2e: aktivitaeten.spec.ts AC6 ..."), der Schluessel im Body nicht.
//
// Zeilenanker (multiline 'm'), damit Fliesstext ("... siehe Fund: irgendwo")
// nicht triggert -- dieselbe Vorsicht wie bei ENTRY_LINE oben. #410 R1/AK1:
// globales Flag statt nur der ersten Zeile -- ein Ticket, das dieselbe
// Ursache in mehreren roten Tests belegt, traegt mehrere 'Fund:'-Zeilen.
const FIND_KEY_LINE = /^\s*Fund:\s*(.+?)\s*$/gm;

// Alle Schluessel eines Bodys, in Dokumentreihenfolge, dedupliziert.
export function parseFindKeys(body: string | undefined | null): string[] {
  if (!body) return [];
  const keys = [...body.matchAll(FIND_KEY_LINE)].map((match) => match[1]!);
  return [...new Set(keys)];
}

// Alle Fund-Tickets eines Schnappschusses, aeltestes zuerst (Tie-Break:
// Ticketnummer) -- treibt sowohl die Prompt-Zeile (AC3) als auch
// findFoundTicket() unten. #410 R4/AK9: 'inProgress' reicht durch, ob das
// Ticket gerade gebaut wird -- der Snapshot traegt 'labels' bereits, kein
// zusaetzlicher gh-Aufruf noetig.
export function foundTickets(snapshot: QueueIssue[]): { number: number; keys: string[]; inProgress: boolean }[] {
  return snapshot
    .filter((issue) => parseFindKeys(issue.body).length > 0)
    .sort((a, b) => byCreatedAt(a, b) || a.number - b.number)
    .map((issue) => ({
      number: issue.number,
      keys: parseFindKeys(issue.body),
      inProgress: hasLabel(issue, 'in-progress'),
    }));
}

// AC2: zu einem Fundschluessel das bestehende Ticket finden -- zustandsagnostisch
// (offen wie geschlossen; der Aufrufer liefert das ueber einen Schnappschuss mit
// '--state all'). Mehrere Treffer: das AELTESTE gewinnt, denn das ist das
// urspruengliche Ticket -- alles danach war bereits ein vermeidbares Duplikat.
export function findFoundTicket(key: string, snapshot: QueueIssue[]): number | null {
  const matches = foundTickets(snapshot).filter((entry) => entry.keys.includes(key));
  return matches.length > 0 ? matches[0]!.number : null;
}
