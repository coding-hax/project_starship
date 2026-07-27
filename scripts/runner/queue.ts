// Prioritaets-Queue-Funktionen, portiert aus claude-runner.sh (#199, S2 von
// #184). Reine Funktionen -- kein `gh`, das Snapshot-JSON und der Queue-Body
// kommen als Parameter, genau wie auf der Bash-Seite.
//
// Leseregel bleibt exakt wie heute: JEDE Raute-Nummer im Queue-Body zaehlt,
// auch in Notizbloecken -- kein Nachschaerfen (siehe #199 Nicht-Ziele).

export interface QueueIssue {
  number: number;
  labels: { name: string }[];
  createdAt?: string;
}

// Exportiert fuer select.ts (#202 S5) -- dieselbe Label-/Sortierlogik wird
// dort fuer die volle Ticketauswahl-Kaskade (inkl. research) gebraucht.
export function hasLabel(issue: QueueIssue, name: string): boolean {
  return issue.labels.some((label) => label.name === name);
}

export function byCreatedAt(a: QueueIssue, b: QueueIssue): number {
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

// Body-Text -> Liste aller '#NN' in Dokumentreihenfolge, dublettenbereinigt.
export function queueOrderFlat(body: string): number[] {
  if (!body) return [];
  const matches = body.match(/#[0-9]+/g) ?? [];
  const order: number[] = [];
  const seen = new Set<number>();
  for (const match of matches) {
    const n = Number(match.slice(1));
    if (!seen.has(n)) {
      seen.add(n);
      order.push(n);
    }
  }
  return order;
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
