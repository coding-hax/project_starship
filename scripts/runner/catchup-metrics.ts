// Telemetrie fuer den Nachzieh-Overhead der Flotte (#515, P2) -- rein additiv
// neben dem bestehenden Nachzieh-Ablauf (catchup.ts), aendert keine Reaktion.
// Jeder Slot fuehrt SEINE EIGENE Datei `catchup-<slotId>.log` direkt unter
// SHARED_DIR (eine Epoch-ms-Zeile je erfolgreichem Nachziehen) -- der Tick je
// Slot ist einfaedig, deshalb schreibt hier nie mehr als ein Slot dieselbe
// Datei und es braucht kein Cross-Slot-Locking.
import type { Clock } from './clock.js';
import type { StateAdapter } from './state.js';

const WINDOW_MS = 7 * 24 * 3600_000;

function fileOf(slotId: string): string {
  return `catchup-${slotId}.log`;
}

function parseTimestamps(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

// Haengt EIN Ereignis (jetzt) an die Slot-Datei an, verwirft dabei Zeilen
// aelter als 7 Tage -- die Datei waechst so nie unbegrenzt.
export function recordCatchup(slotId: string, sharedState: StateAdapter, clock: Clock): void {
  const now = clock.now().getTime();
  const name = fileOf(slotId);
  const kept = parseTimestamps(sharedState.read(name)).filter((ts) => now - ts <= WINDOW_MS);
  kept.push(now);
  sharedState.write(name, `${kept.join('\n')}\n`);
}

// Summiert ueber alle Slot-Dateien, wie viele Nachzieh-Ereignisse innerhalb
// des Fensters liegen -- eine fehlende/kaputte Datei zaehlt als 0.
export function catchupCountWindow(
  slotIds: string[],
  sharedState: StateAdapter,
  clock: Clock,
  windowMs: number = WINDOW_MS,
): number {
  const now = clock.now().getTime();
  let total = 0;
  for (const slotId of slotIds) {
    const timestamps = parseTimestamps(sharedState.read(fileOf(slotId)));
    total += timestamps.filter((ts) => now - ts <= windowMs).length;
  }
  return total;
}
