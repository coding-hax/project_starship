// Weicht die AUSGEFUEHRTE Shim-Datei von der reviewten Fassung im Ref ab?
//
// Warum das hier liegt und nicht im Shim selbst (#252): der Shim ist die eine
// Datei, die laeuft, ohne im Repo zu liegen. Traege er die Pruefung selbst, kann
// eine zu alte Fassung nicht melden, dass sie zu alt ist -- das Loch waere genau
// dort, wo die Zusage gebraucht wird. claude-runner.sh wird dagegen bei JEDEM
// Tick frisch aus origin/main materialisiert; von hier aus greift die Meldung
// auch gegen einen uralten installierten Shim.
import { readFileSync } from 'node:fs';
import type { GitAdapter } from './git.js';

export const SHIM_CANONICAL = 'scripts/starship-runner';

export type ReadFileFn = (path: string) => string;

const defaultRead: ReadFileFn = (path) => readFileSync(path, 'utf-8');

// Der git-Adapter schneidet abschliessende Newlines ab (wie `$(...)` in bash).
// Die Dateiseite muss deshalb genauso normalisiert werden -- sonst meldete ein
// blosses Zeilenende-Delta einen Drift, den es nicht gibt.
function normalise(text: string): string {
  return text.replace(/\r?\n+$/, '');
}

// Rueckgabe: '' = kein Drift (Bash sieht leeren stdout), sonst der Grund.
export function shimDriftReason(
  installedPath: string,
  ref: string,
  git: GitAdapter,
  readFile: ReadFileFn = defaultRead,
): string {
  if (installedPath === '') return '';

  let canonical: string;
  try {
    canonical = git.run(['show', `${ref}:${SHIM_CANONICAL}`]);
  } catch {
    // Im Ref nicht vorhanden (aelterer main) -- ausdruecklich KEIN Drift,
    // sonst schluege jeder Lauf gegen einen alten Stand Alarm.
    return '';
  }
  if (normalise(canonical) === '') return '';

  let installed: string;
  try {
    installed = readFile(installedPath);
  } catch {
    // Keine installierte Datei -- auf Linux ist das der Normalfall, dort gibt es
    // den Shim gar nicht (systemd startet claude-runner.sh direkt).
    return '';
  }

  if (normalise(installed) === normalise(canonical)) return '';

  return `Die laufende Datei \`${installedPath}\` weicht von \`${ref}:${SHIM_CANONICAL}\` ab.`;
}
