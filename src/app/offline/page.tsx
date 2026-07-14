export const metadata = { title: 'Offline · Starship' };

/**
 * The service-worker fallback for a document request that cannot be served.
 * Offline is a quiet note, not an error — nothing blinks red just because the
 * network is gone (DESIGN_SYSTEM.md).
 */
export default function OfflinePage() {
  return (
    <main className="auth">
      <h1>Kein Netz</h1>
      <p style={{ color: 'var(--text-muted)' }}>
        Diese Seite ist noch nicht offline verfügbar. Deine Änderungen sind gespeichert und werden
        gesendet, sobald du wieder online bist.
      </p>
    </main>
  );
}
