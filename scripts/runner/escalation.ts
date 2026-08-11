// Eskalation, Wiederaufnahme-Deckel und Blocker-Signatur, portiert aus
// claude-runner.sh (#200, S3 von #184). Zustand ausschliesslich ueber den
// `state`-Adapter, GitHub-Zugriff ausschliesslich ueber `gh`/`git` -- nie
// direkt `execFileSync`, damit Vitest sie durch Doubles ersetzen kann.
import { createHash } from 'node:crypto';
import type { GhAdapter } from './gh.js';
import type { GitAdapter } from './git.js';
import type { StateAdapter } from './state.js';
import { tierBump, tierReset } from './tier.js';

// Portable sha1 -- entspricht `shasum -a 1`/`sha1sum` (nur der Hash, ohne den
// Dateinamen-Teil, den `cut -d' ' -f1` auf der Bash-Seite abschneidet).
export function sha1Of(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

// Resume-Deckel (#62): nach 2 Fortsetzungen einer Session frisch starten.
// Zaehler dateibasiert je Ticket, analog failcount.
export interface ResumeResult {
  allowed: boolean;
}

export function resumeAllowed(issue: number, state: StateAdapter): ResumeResult {
  const key = `resume-count-${issue}`;
  const raw = state.read(key);
  const count = raw !== null ? Number(raw.trim()) || 0 : 0;
  if (count >= 2) {
    state.write(key, '0\n');
    return { allowed: false };
  }
  state.write(key, `${count + 1}\n`);
  return { allowed: true };
}

const BLOCKER_LINE_RE = /Lauf-Ende|← HIER WEITER|Endgrund/;

export const PROGRESS_MARKER = 'Fortschritt (automatisch aktualisiert)';

// sha1 der Blocker-Kennzeilen (Endgrund + Wiederaufnahmestelle) aus dem
// LETZTEN Kommentar -- aber nur, wenn das ueberhaupt der Fortschrittskommentar
// ist (#33). Kein Fortschrittskommentar (Lauf brach ganz frueh ab) -> ''.
export function blockerSig(issue: number, gh: GhAdapter): string {
  let last = '';
  try {
    last = gh.run([
      'issue',
      'view',
      String(issue),
      '--json',
      'comments',
      '-q',
      '.comments[-1].body // empty',
    ]);
  } catch {
    last = '';
  }
  if (!last.includes(PROGRESS_MARKER)) return '';

  const body = last
    .split('\n')
    .filter((line) => BLOCKER_LINE_RE.test(line))
    .join('\n');
  if (!body) return '';
  return sha1Of(body);
}

// SHA der Feature-Branch-Spitze auf origin ('', wenn (noch) kein Branch
// existiert) -- entspricht branch_tip() in claude-runner.sh. Kein eigenes
// ts_run-Kommando (nicht Teil der #200-Akzeptanzkriterien), nur ein interner
// Baustein von buildEscalationEval.
function branchTip(issue: number, git: GitAdapter): string {
  let out = '';
  try {
    out = git.run(['ls-remote', '--heads', 'origin', `feat/${issue}-*`, `fix/${issue}-*`, `chore/${issue}-*`]);
  } catch {
    return '';
  }
  const firstLine = out.split('\n')[0] ?? '';
  return firstLine.split(/\s+/)[0] ?? '';
}

// F26/#499: erkennt, ob DIESER Lauf einen Fortschrittskommentar angelegt hat,
// waehrend die Branch-Spitze stehen blieb -- updatedAt/lastEditedAt liefert
// gh durchweg null (verifiziert an #430), darum createdAt gegen runStart.
// Rein lesend, best effort: jeder Fehler -> false, keine Meldung.
export function progressCommentWrittenThisRun(issue: number, gh: GhAdapter, runStart: string): boolean {
  if (!runStart) return false;
  const start = new Date(runStart).getTime();
  if (Number.isNaN(start)) return false;
  try {
    const raw = gh.run(['issue', 'view', String(issue), '--json', 'comments']);
    const parsed = JSON.parse(raw) as { comments?: Array<{ body?: string; createdAt?: string }> };
    return (parsed.comments ?? []).some((c) => {
      if (!c.body?.includes(PROGRESS_MARKER) || !c.createdAt) return false;
      const created = new Date(c.createdAt).getTime();
      return !Number.isNaN(created) && created >= start;
    });
  } catch {
    return false;
  }
}

export interface EscalationInput {
  issue: number;
  runRole: string;
  labels: string;
  beforeTip: string;
  model: string;
  /** Laufbeginn (ISO), nur fuer die Bau-Rolle befuellt -- Basis fuer
   * progressCommentWrittenThisRun(). undefined/'' = kein Check (#499). */
  runStart?: string;
}

// Fortschritts-/Fehlschlag-Auswertung. Wird NUR an den inhaltlich "fertigen"
// Ausgaengen der Bau-Rolle aufgerufen (siehe claude-runner.sh) -- ausdruecklich
// NICHT bei Limit/429, Notbremse oder einem noch laufenden Transient-Retry.
export function buildEscalationEval(
  input: EscalationInput,
  state: StateAdapter,
  gh: GhAdapter,
  git: GitAdapter,
): void {
  const { issue, runRole, labels, beforeTip, model, runStart } = input;
  if (runRole !== 'build') return;
  if (labels.includes('no-escalation')) return;

  const after = branchTip(issue, git);
  if (after && after !== beforeTip) {
    tierReset(issue, state); // Fortschritt -- zurueck auf die Default-Stufe.
    return;
  }

  // F26/#499: Spitze steht, aber dieser Lauf hat trotzdem einen
  // Fortschrittskommentar angelegt -- die gemeldete Arbeit ist nicht durch
  // Git gedeckt. Eigener Kommentar, NIE --edit-last (AK4), kein
  // needs-answer -- die gewoehnliche Eskalation laeuft unveraendert weiter.
  if (progressCommentWrittenThisRun(issue, gh, runStart ?? '')) {
    try {
      gh.run([
        'issue',
        'comment',
        String(issue),
        '--body',
        '🤖 Auffälligkeit: Dieser Bau-Lauf hat den Fortschrittskommentar aktualisiert, aber die Branch-Spitze hat sich nicht bewegt — kein neuer Commit/Push deckt den gemeldeten Stand. Bitte prüfen, bevor ein Folge-Lauf ihm glaubt. (Der Fortschrittskommentar wurde nicht verändert.)',
      ]);
    } catch {
      // best effort
    }
  }

  // opus-boost (#136) wird von einem ERGEBNISLOSEN Opus-Bau-Lauf verbraucht --
  // ein Tap deckt genau einen erfolglosen Versuch ab. Bei Fortschritt (Zweig
  // oben) bleibt das Label bewusst haengen, auf einem anderen Modell als Opus
  // waere der Verbrauch verschwendet.
  if (model === 'opus' && labels.includes('opus-boost')) {
    try {
      gh.run(['issue', 'edit', String(issue), '--remove-label', 'opus-boost']);
    } catch {
      // best effort, wie >/dev/null 2>&1 auf der Bash-Seite.
    }
  }

  const sig = blockerSig(issue, gh);
  const prev = state.read(`blocker-sig-${issue}`) ?? '';
  if (sig) state.write(`blocker-sig-${issue}`, sig);

  // Nur eine ECHTE Aenderung gegenueber einer bereits bekannten Signatur zaehlt
  // als "die Wand hat sich bewegt". Gibt es noch keine gespeicherte Signatur
  // (erster Fehlversuch ueberhaupt), ist das keine Aenderung, sondern die
  // Baseline -- der Fehlversuch selbst zaehlt trotzdem (siehe unten).
  if (prev && sig && sig !== prev) {
    state.write(`failcount-${issue}`, '0\n');
    return;
  }

  const currentFc = state.read(`failcount-${issue}`);
  const fc = (currentFc !== null ? Number(currentFc.trim()) || 0 : 0) + 1;
  state.write(`failcount-${issue}`, `${fc}\n`);
  if (fc < 3) return;

  if (tierBump(issue, state, gh)) {
    try {
      gh.run([
        'issue',
        'comment',
        String(issue),
        '--body',
        '🤖 Drei Läufe ohne Fortschritt auf der aktuellen Modellstufe — der nächste Bau-Versuch eskaliert auf Opus (siehe ADR-0007, Deckel 2 Opus-Bau-Läufe/Tag).',
      ]);
    } catch {
      // best effort
    }
  } else {
    try {
      gh.run([
        'issue',
        'comment',
        String(issue),
        '--body',
        '🤖 Auch Opus ist dreimal in Folge ohne Fortschritt stecken geblieben. Die Eskalation ist erschöpft.',
      ]);
    } catch {
      // best effort
    }
    try {
      gh.run(['issue', 'edit', String(issue), '--add-label', 'needs-answer']);
    } catch {
      // best effort
    }
  }
}
