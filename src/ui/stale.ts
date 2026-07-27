/**
 * "Wie alt ist der letzte erfolgreiche Abgleich?" — geteilt zwischen Wetter
 * (issue #155) und Aktivitäten (issue #230), weil beide dieselbe Frage stellen
 * und dieselbe Bildunterschrift zeigen.
 *
 * Der Schwellwert stammt aus dem Wetter-Fall: zwei vergebliche Anläufe seines
 * 3h-Fensters. Für Aktivitäten (30-Minuten-Fenster) sind acht Stunden entsprechend
 * großzügiger — bewusst, denn eine Uhr, die einen Tag lang nicht mit Garmin Connect
 * gesprochen hat, ist kein Fehler der App.
 */
const STALE_WARNING_THRESHOLD_MS = 8 * 60 * 60 * 1000;

export function isStaleWarning(fetchedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(fetchedAt).getTime() >= STALE_WARNING_THRESHOLD_MS;
}

/** `HH:MM`, 24-hour, local time (VISION) — the last successful fetch. */
export function formatStaleSince(fetchedAt: string): string {
  const date = new Date(fetchedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
