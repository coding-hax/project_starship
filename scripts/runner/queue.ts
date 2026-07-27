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
// research, jeweils OHNE needs-input.
export function queuePending(snapshot: QueueIssue[]): string {
  return snapshot
    .filter((issue) => {
      const eligible =
        hasLabel(issue, 'ready') || hasLabel(issue, 'plan') || hasLabel(issue, 'research');
      return eligible && !hasLabel(issue, 'needs-input');
    })
    .map((issue) => issue.number)
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(', ');
}

// Das Ticket, das der Runner beim naechsten Takt naehme -- Praezedenz:
// laufendes in-progress -> flache Queue (Label egal) -> plan ->
// ready. `null`, wenn nichts baubereit ist.
//
// `hands-off` (frueher 'no-opus') wird EINMAL zentral vom Snapshot gefiltert,
// nicht je Zweig -- dieselbe Form wie `selectTicket()` seit #227. Sonst
// vergisst der naechste Zweig den Ausschluss wieder, und die Anzeige nennt ein
// Ticket, das der Runner gar nicht baut (#271).
export function queueNext(snapshot: QueueIssue[], queueBody = ''): number | null {
  const selectable = snapshot.filter((issue) => !hasLabel(issue, 'hands-off'));

  const runningInProgress = selectable
    .filter((issue) => hasLabel(issue, 'in-progress') && !hasLabel(issue, 'needs-input'))
    .sort(byCreatedAt)[0];
  if (runningInProgress) return runningInProgress.number;

  const order = queueOrderFlat(queueBody);
  if (order.length > 0) {
    const ranked = selectable
      .filter((issue) => order.includes(issue.number))
      .filter((issue) => !hasLabel(issue, 'needs-input'))
      .sort((a, b) => order.indexOf(a.number) - order.indexOf(b.number));
    if (ranked.length > 0) return ranked[0].number;
  }

  const nextPlan = selectable
    .filter((issue) => hasLabel(issue, 'plan') && !hasLabel(issue, 'needs-input'))
    .sort(byCreatedAt)[0];
  if (nextPlan) return nextPlan.number;

  const nextReady = selectable
    .filter(
      (issue) =>
        hasLabel(issue, 'ready') &&
        !hasLabel(issue, 'needs-input') &&
        !hasLabel(issue, 'plan') &&
        !hasLabel(issue, 'research'),
    )
    .sort(byCreatedAt)[0];
  if (nextReady) return nextReady.number;

  return null;
}
