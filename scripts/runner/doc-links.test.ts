// Maschineller Nachweis fuer #446 (WORKFLOW.md-Split): haelt CLAUDE.md und
// die referenzierten docs/-Dateien synchron, damit ein Verweis nie auf eine
// nicht (mehr) existierende Datei, eine verrottete Ueberschrift oder eine
// wieder ueber 10 KB gewachsene Datei zeigt -- genau die drei Anker-Risiken,
// die der Split sonst nur durch sorgfaeltiges Von-Hand-Pruefen abfaengt.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MAX_BYTES = 10 * 1024;

// CLAUDE.md hat einen eigenen, groesseren Deckel (#768). Bis dahin war sie die
// einzige Datei OHNE Deckel -- ausgerechnet die eine, die laut prompts.ts jeder
// Lauf als Pflichtlektuere liest, waehrend jede nur bei Anlass gelesene Datei
// auf 10 KB begrenzt war.
//
// 14 KB statt 10 KB, weil #768 gemessen hat, dass der Boden der Inhalt selbst
// ist: 85 atomare Regeln mal ~150 B. Der Umbau hat 19,0 -> 13,1 KB gebracht,
// indem jede Regel nur noch einmal dasteht (gegliedert nach Moment im Lauf) und
// die Begruendungen nach docs/warum/ gewandert sind. Weiter runter geht nur,
// indem ganze Abschnitte aus dem Erstkontakt verschwinden -- bewusst nicht
// getan, siehe #768. Der Deckel laesst Nachtraege zu und wird rot, sobald die
// Datei wieder in Richtung ihres alten Umfangs waechst.
const CLAUDE_MD_MAX_BYTES = 14 * 1024;

// docs/CODEMAP.md ist die bewusst grosse Ausnahme (Token-Disziplin Punkt 1,
// CLAUDE.md): sie ist die Antwort auf "wo liegt...?" und soll im Ganzen
// gelesen werden, nicht abschnittsweise wie WORKFLOW.md. Ihre Groesse ist ein
// vorbestehendes, bekanntes Faktum -- eine eigene Diaet ist ein eigenes
// Ticket (siehe #446-Plankommentar, "Folge-Ticket"), nicht dieser Split hier.
//
// docs/adr/** ist als Kategorie ausgenommen: ADRs sind historische
// Entscheidungsprotokolle (CLAUDE.md: "werden nicht neu verhandelt"), nicht
// Teil des WORKFLOW-Splits, den #446 durchfuehrt. Sie bleiben von sich aus
// klein (das #446-Ticket selbst nennt sie "unproblematisch -- 3-8 KB"), aber
// eine spaetere, fachlich berechtigte Ergaenzung durch ein ANDERES Ticket
// (z. B. #449s Verweis von ADR-0014 auf das neue ADR-0020) darf nicht rot
// werden, nur weil sie ein paar Bytes ueber die 10-KB-Linie dieses Tests
// schiebt -- dieser Test ist fuer den WORKFLOW-Split da, nicht als Dauer-Gate
// auf fremden, bereits gemergten ADR-Text.
const SIZE_EXEMPT_FILES = new Set(['docs/CODEMAP.md']);
function isSizeExempt(path: string): boolean {
  return SIZE_EXEMPT_FILES.has(path) || path.startsWith('docs/adr/');
}

function claudeMd(): string {
  return readFileSync(join(ROOT, 'CLAUDE.md'), 'utf-8');
}

// Jeder Verweis der Form `docs/irgendwas.md` in Backticks -- unabhaengig
// davon, ob ein Abschnittsanker danebensteht.
function referencedDocs(text: string): string[] {
  const paths = [...text.matchAll(/`(docs\/[^`]+\.md)`/g)].map((m) => m[1]!);
  return [...new Set(paths)];
}

// Die Form "`docs/....md`, „Abschnittsname"" -- ein benannter Anker, der als
// echte Ueberschrift in der Zieldatei existieren muss (haertet genau die 2
// Prosa-Anker, die die #446-Recherche als bereits verrottet fand).
function referencedAnchors(text: string): { path: string; anchor: string }[] {
  return [...text.matchAll(/`(docs\/[^`]+\.md)`,\s*„([^"]+)"/g)].map((m) => ({
    path: m[1]!,
    anchor: m[2]!,
  }));
}

describe('CLAUDE.md-Verweise <-> docs/ (#446 AC1-3)', () => {
  it('jeder docs/*.md-Verweis in CLAUDE.md zeigt auf eine existierende Datei', () => {
    const missing = referencedDocs(claudeMd()).filter((path) => !existsSync(join(ROOT, path)));
    expect(missing, `Toter Verweis in CLAUDE.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('CLAUDE.md selbst bleibt unter ihrem eigenen Deckel (#768 AK5)', () => {
    const size = statSync(join(ROOT, 'CLAUDE.md')).size;
    expect(
      size,
      `CLAUDE.md ist ${size} B und damit ueber dem Deckel von ${CLAUDE_MD_MAX_BYTES} B. ` +
        `Jeder Lauf liest sie als Pflichtlektuere -- Zuwachs kostet Kontingent in jedem ` +
        `einzelnen Lauf. Neue Begruendung gehoert nach docs/warum/, neue Ablaufdetails ` +
        `nach docs/workflow/. Steht hier wirklich eine neue REGEL, hebe den Deckel bewusst ` +
        `und begruende es im Ticket.`,
    ).toBeLessThan(CLAUDE_MD_MAX_BYTES);
  });

  it('jede referenzierte Datei ist unter 10 KB (ausser der dokumentierten Ausnahme)', () => {
    const tooBig = referencedDocs(claudeMd())
      .filter((path) => !isSizeExempt(path))
      .filter((path) => statSync(join(ROOT, path)).size >= MAX_BYTES);
    expect(tooBig, `>= 10 KB, obwohl aus CLAUDE.md referenziert: ${tooBig.join(', ')}`).toEqual([]);
  });

  it('jeder benannte Abschnittsanker existiert als echte Ueberschrift in der Zieldatei', () => {
    const broken = referencedAnchors(claudeMd())
      .filter(({ path, anchor }) => {
        const lines = readFileSync(join(ROOT, path), 'utf-8').split('\n');
        return !lines.some((line) => /^#{1,6}\s/.test(line) && line.includes(anchor));
      })
      .map(({ path, anchor }) => `${path} „${anchor}"`);
    expect(broken, `Anker ohne echte Ueberschrift: ${broken.join(' | ')}`).toEqual([]);
  });
});

describe('Interne Links zwischen docs/workflow/*.md (#446 Bonus-AC)', () => {
  it('jeder docs/workflow/*.md-Verweis innerhalb der Split-Dateien zeigt auf eine existierende Datei', () => {
    const dir = join(ROOT, 'docs', 'workflow');
    const files = readdirSync(dir).filter((name) => name.endsWith('.md'));

    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf-8');
      for (const path of referencedDocs(text)) {
        if (!existsSync(join(ROOT, path))) broken.push(`${file} -> ${path}`);
      }
    }
    expect(broken, `Toter interner Link: ${broken.join(', ')}`).toEqual([]);
  });
});
