/**
 * The manual "kick" for the nightly Garmin cron is bewusst nicht Outbox-geführt
 * (wie push.ts) — es schreibt kein Domänendatum, es stößt nur den Server-seitigen
 * Sync an, der selbst nach Postgres schreibt (issue #230). Diese Datei ist deshalb
 * die eine Stelle, die gegen /api/garmin-sync spricht (check-sync-invariants.sh
 * nimmt src/local/** ausdrücklich aus, siehe push.ts). Feature-Code ruft nie
 * selbst fetch() auf.
 */

/** Resolves once the server-side sync has run; throws on any non-2xx status. */
export async function triggerGarminSync(): Promise<void> {
  const response = await fetch('/api/garmin-sync', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`garmin-sync antwortete mit Status ${response.status}`);
  }
}
