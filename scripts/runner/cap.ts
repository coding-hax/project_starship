// Harter Opus-Bau-Deckel (ADR-0007), portiert aus claude-runner.sh (#200, S3
// von #184): hoechstens 2 Opus-Bau-Laeufe pro Ticket und Kalendertag. Eigener,
// tagesgestempelter Zaehler unter $STATE_DIR -- unabhaengig vom Clock-Adapter
// nur fuer das Tagesdatum (lokale Zeit, wie `date +%Y%m%d`).
import type { Clock } from './clock.js';
import type { StateAdapter } from './state.js';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function todayStamp(clock: Clock): string {
  const now = clock.now();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

// $labels als Roh-String (wie $LABELS auf der Bash-Seite) -- 'opus-boost'
// umgeht den Deckel unabhaengig vom Zaehlerstand.
export function opusBuildCapReached(
  issue: number,
  labels: string,
  state: StateAdapter,
  clock: Clock,
): boolean {
  if (labels.includes('opus-boost')) return false;
  const raw = state.read(`opus-build-${todayStamp(clock)}-${issue}`);
  const count = raw !== null ? Number(raw.trim()) || 0 : 0;
  return count >= 2;
}

// Verbraucht einen der 2 Slots fuer heute.
export function opusBuildCapReserve(issue: number, state: StateAdapter, clock: Clock): void {
  const key = `opus-build-${todayStamp(clock)}-${issue}`;
  const raw = state.read(key);
  const count = raw !== null ? Number(raw.trim()) || 0 : 0;
  state.write(key, `${count + 1}\n`);
}

// Flottenweiter Denk-Rollen-Deckel (#492, Nachtrag zu ADR-0005): begrenzt die
// Laeufe der Rollen plan+research in Summe -- ticketuebergreifend (ein
// Zaehler, kein `-${issue}`-Suffix wie beim Opus-Bau-Deckel) und unabhaengig
// vom aufgeloesten Modell. Bau-Laeufe bleiben bewusst unbegrenzt, die deckelt
// schon die Eskalation aus ADR-0007. Ohne diesen Deckel verbrennt ein
// versehentlich `plan`-markiertes Ticket, das nach jedem Lauf neu eingeplant
// wird, ein ganzes Tageskontingent, ohne dass ein einzelner bestehender
// Deckel je greift (Ticket-Text #492). 20/Tag ist grosszuegig ueber dem
// normalen Planungs-/Recherche-Durchsatz gewaehlt und rein eine Kostenbremse
// -- kein Befund, der eine exaktere Herleitung braucht; bei Bedarf per
// Folge-Ticket nachjustierbar.
const THINKING_ROLE_CAP_DAILY = 20;

function thinkingCapKey(clock: Clock): string {
  return `thinking-cap-${todayStamp(clock)}`;
}

export function thinkingCapReached(state: StateAdapter, clock: Clock): boolean {
  const raw = state.read(thinkingCapKey(clock));
  const count = raw !== null ? Number(raw.trim()) || 0 : 0;
  return count >= THINKING_ROLE_CAP_DAILY;
}

// Verbraucht einen der 20 Slots fuer heute.
export function thinkingCapReserve(state: StateAdapter, clock: Clock): void {
  const key = thinkingCapKey(clock);
  const raw = state.read(key);
  const count = raw !== null ? Number(raw.trim()) || 0 : 0;
  state.write(key, `${count + 1}\n`);
}
