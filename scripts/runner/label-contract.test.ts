// Haelt Label-Beschreibung und Label-Verhalten zusammen (#266, S4 von #264).
//
// Der Anlass: `no-opus` (heute `hands-off`) beschrieb sich als "der Runner
// fasst dieses Ticket gar nicht an", wurde aber in drei von sechs
// Auswahlzweigen nicht geprueft (#227). Gemerkt hat das niemand, bis am
// 26.07.26 ein ungewollter Opus-Bau-Lauf auf einem lokal bearbeiteten Ticket
// startete. Eine Beschreibung, die luegt, ist schlimmer als keine -- man
// verlaesst sich darauf.
//
// Diese Suite prueft zwei Dinge, die sonst nur durch Hinsehen zusammenhaengen:
//
//   1. VOLLSTAENDIGKEIT -- jedes Label, das `bootstrap-github.sh` anlegt, steht
//      in der Tabelle in docs/WORKFLOW.md, und umgekehrt. Ein neues Label ohne
//      Doku faellt auf, eine Doku-Zeile ohne Label ebenso.
//   2. VERHALTEN -- jedes Label aus `BLOCKING_LABELS` haelt ein Ticket auf
//      JEDEM Zweig der Auswahl-Kaskade heraus, nicht nur auf dem, an den
//      jemand gerade gedacht hat. Das ist der Teil, der die Klasse Fehler
//      faengt, um die es in #227 ging.
//
// Bewusst NICHT geprueft: die Farben und Texte, die auf GitHub tatsaechlich
// gesetzt sind. Das braeuchte einen Netzzugriff im Test und wuerde die Suite
// von einem fremden Zustand abhaengig machen.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKING_LABELS, selectTicket } from './select';
import type { QueueIssue } from './queue';

const ROOT = join(__dirname, '..', '..');

function bootstrapLabels(): string[] {
  const text = readFileSync(join(ROOT, 'scripts', 'bootstrap-github.sh'), 'utf-8');
  return [...text.matchAll(/^label\s+"([^"]+)"/gm)].map((m) => m[1]!);
}

// Die Label-Tabelle in docs/WORKFLOW.md: Zeilen, die mit '|' beginnen, erste
// Zelle, alle in Backticks stehenden Namen. Eine Zelle darf mehrere tragen
// (`model:haiku` `model:sonnet` `model:opus`) -- sie beschreiben dasselbe
// Verhalten und teilen sich eine Zeile.
function documentedLabels(): string[] {
  const text = readFileSync(join(ROOT, 'docs', 'WORKFLOW.md'), 'utf-8');
  const start = text.indexOf('## Labels — sie steuern den Runner');
  expect(start, 'Abschnitt "## Labels — sie steuern den Runner" fehlt in docs/WORKFLOW.md').toBeGreaterThan(-1);
  const section = text.slice(start, text.indexOf('\n## ', start + 5));

  const labels: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    if (firstCell.includes('---') || firstCell.trim() === 'Label') continue;
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) labels.push(match[1]!);
  }
  return labels;
}

describe('Label-Vollstaendigkeit: bootstrap <-> docs/WORKFLOW.md (#266 AC1)', () => {
  it('jedes angelegte Label steht in der Tabelle', () => {
    const missing = bootstrapLabels().filter((label) => !documentedLabels().includes(label));
    expect(missing, `In bootstrap-github.sh angelegt, aber in docs/WORKFLOW.md nicht beschrieben: ${missing.join(', ')}`).toEqual([]);
  });

  it('jedes beschriebene Label wird auch angelegt', () => {
    const extra = documentedLabels().filter((label) => !bootstrapLabels().includes(label));
    expect(extra, `In docs/WORKFLOW.md beschrieben, aber von bootstrap-github.sh nicht angelegt: ${extra.join(', ')}`).toEqual([]);
  });

  // Ein frisch aufgesetztes Repo muss die Steuerung vollstaendig haben. Genau
  // hier fehlten bis #266 'no-escalation' und 'opus-boost' -- der Kill-Switch
  // gegen die Opus-Eskalation und sein Gegenstueck.
  it('legt die Labels an, die der Runner-Kern tatsaechlich liest', () => {
    for (const label of [...BLOCKING_LABELS, 'ready', 'in-progress', 'plan', 'research', 'no-escalation', 'opus-boost', 'blocked-limit', 'blocked-by', 'tests-exempt']) {
      expect(bootstrapLabels(), `bootstrap-github.sh legt '${label}' nicht an`).toContain(label);
    }
  });

  it('legt kein Label doppelt an', () => {
    const seen = bootstrapLabels();
    expect(seen).toEqual([...new Set(seen)]);
  });
});

// --- Der eigentliche Punkt (#266 AC2) ---------------------------------------
// Die Kaskade hat fuenf Eintrittsstellen. Ein Ausschluss-Label muss auf ALLEN
// greifen. Der Test baut je Zweig einen Schnappschuss, in dem das Ticket ohne
// das Label gewaehlt wuerde -- und besteht darauf, dass es mit dem Label nicht
// gewaehlt wird.
describe('Ausschluss-Labels greifen auf jedem Zweig (#266 AC2)', () => {
  const OTHER = '2024-06-01T00:00:00Z';
  const issue = (number: number, labels: string[], createdAt = '2024-01-01T00:00:00Z'): QueueIssue => ({
    number,
    labels: labels.map((name) => ({ name })),
    createdAt,
  });

  const branches: { name: string; labels: string[]; queueBody?: string }[] = [
    { name: 'running (in-progress)', labels: ['in-progress'] },
    { name: 'Prioritaets-Queue', labels: [], queueBody: '- #10' },
    { name: 'plan', labels: ['plan'] },
    { name: 'research', labels: ['research'] },
    { name: 'ready', labels: ['ready'] },
  ];

  for (const label of BLOCKING_LABELS) {
    for (const branch of branches) {
      it(`'${label}' schliesst den Zweig ${branch.name} aus`, () => {
        const body = branch.queueBody ?? '';

        // Kontrolle: ohne das Label wuerde genau dieses Ticket gewaehlt --
        // sonst prueft der Fall unten nichts.
        expect(selectTicket([issue(10, branch.labels)], body)?.issue).toBe(10);

        expect(selectTicket([issue(10, [...branch.labels, label])], body)).toBeNull();
      });
    }

    it(`'${label}' laesst den naechsten Kandidaten durch, statt alles anzuhalten`, () => {
      const snapshot = [issue(10, ['ready', label]), issue(20, ['ready'], OTHER)];
      expect(selectTicket(snapshot)?.issue).toBe(20);
    });
  }

  it('traegt jedes Ticket ein Ausschluss-Label, waehlt der Runner gar nichts', () => {
    const snapshot = BLOCKING_LABELS.map((label, i) => issue(10 + i, ['ready', label]));
    expect(selectTicket(snapshot)).toBeNull();
  });
});
