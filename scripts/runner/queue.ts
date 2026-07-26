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
// dort fuer die volle Ticketauswahl-Kaskade (inkl. needs-research) gebraucht.
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

// Offene Queue-Arbeit als "#a, #b" (leer = nichts offen): ready|needs-plan|
// needs-research, jeweils OHNE needs-input.
export function queuePending(snapshot: QueueIssue[]): string {
  return snapshot
    .filter((issue) => {
      const eligible =
        hasLabel(issue, 'ready') || hasLabel(issue, 'needs-plan') || hasLabel(issue, 'needs-research');
      return eligible && !hasLabel(issue, 'needs-input');
    })
    .map((issue) => issue.number)
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(', ');
}

// Das Ticket, das der Runner beim naechsten Takt naehme -- Praezedenz:
// laufendes in-progress -> flache Queue (Label egal) -> needs-plan ->
// ready. `null`, wenn nichts baubereit ist.
export function queueNext(snapshot: QueueIssue[], queueBody = ''): number | null {
  const runningInProgress = snapshot
    .filter((issue) => hasLabel(issue, 'in-progress') && !hasLabel(issue, 'needs-input'))
    .sort(byCreatedAt)[0];
  if (runningInProgress) return runningInProgress.number;

  const order = queueOrderFlat(queueBody);
  if (order.length > 0) {
    const ranked = snapshot
      .filter((issue) => order.includes(issue.number))
      .filter((issue) => !hasLabel(issue, 'needs-input') && !hasLabel(issue, 'no-opus'))
      .sort((a, b) => order.indexOf(a.number) - order.indexOf(b.number));
    if (ranked.length > 0) return ranked[0].number;
  }

  const nextNeedsPlan = snapshot
    .filter((issue) => hasLabel(issue, 'needs-plan') && !hasLabel(issue, 'needs-input') && !hasLabel(issue, 'no-opus'))
    .sort(byCreatedAt)[0];
  if (nextNeedsPlan) return nextNeedsPlan.number;

  const nextReady = snapshot
    .filter(
      (issue) =>
        hasLabel(issue, 'ready') &&
        !hasLabel(issue, 'needs-input') &&
        !hasLabel(issue, 'needs-plan') &&
        !hasLabel(issue, 'needs-research'),
    )
    .sort(byCreatedAt)[0];
  if (nextReady) return nextReady.number;

  return null;
}
