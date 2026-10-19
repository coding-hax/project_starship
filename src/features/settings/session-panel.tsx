'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useOnline } from '@/ui/use-online';
import { journalLock } from '@/features/journal/lock-store';
import { lockLocalDatabase } from '@/local/account-isolation';
import { unsubscribeFromPush } from '@/local/push';
import { sync } from '@/local/sync';
import { useSessions } from './use-sessions';
import './session-panel.css';

export function SessionPanel() {
  const online = useOnline();
  const { otherCount, busy: endBusy, error: endError, endOtherSessions } = useSessions();
  const [confirmingLock, setConfirmingLock] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);

  async function lock() {
    setLockBusy(true);
    // A last chance for the outbox to reach the server before the wipe below —
    // not required for correctness (the wipe keeps the outbox either way, see
    // below), just lets the next device see this work sooner. Best-effort:
    // offline, this just fails fast and falls through regardless (AK7, #1201).
    await sync().catch(() => {});
    // Local and network-independent (AK7, #1201) — the wipe must not wait on a
    // request that may never complete offline. The server-side session destroy
    // is best-effort too: it either lands now, or the session simply expires
    // later, same as any other stale cookie (sync.ts's own 401 path wipes again).
    // Keeps the outbox and account marker — see `lockLocalDatabase()` for why: a
    // failed best-effort sync() above must not cost a not-yet-pushed mutation.
    await lockLocalDatabase();
    await journalLock();
    // The push endpoint belongs to this browser, not this account (AK4,
    // #1205) — remove it before the session itself ends, so the next person
    // on this device never gets this account's reminders. Best-effort: the
    // server call needs the still-live session, but a failure here must not
    // block the logout/redirect.
    await unsubscribeFromPush().catch(() => {});
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Offline — the redirect below still happens, that is the whole point.
    }
    window.location.assign('/anmelden');
  }

  return (
    <SectionCard title="Sitzung" className="session-panel">
      {/* "App sperren" braucht seit #1201 kein Netz mehr (AK7) — nur noch das
          Beenden fremder Sitzungen ist ein reiner Server-Aufruf. */}
      {!online && (
        <p className="session-panel__hint">Alle anderen Sitzungen beenden geht nur online.</p>
      )}
      {endError && <p className="session-panel__error">{endError}</p>}

      {confirmingLock ? (
        <Row label="Wirklich sperren?">
          <div className="session-panel__confirm">
            <button
              type="button"
              className="session-panel__button"
              onClick={lock}
              disabled={lockBusy}
            >
              Sperren
            </button>
            <button
              type="button"
              className="session-panel__button session-panel__button--secondary"
              onClick={() => setConfirmingLock(false)}
              disabled={lockBusy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row
          label="App sperren"
          description="Beendet diese Sitzung auf diesem Gerät. Zum Öffnen ist danach wieder Face ID nötig."
        >
          <button
            type="button"
            className="session-panel__button"
            onClick={() => setConfirmingLock(true)}
          >
            App sperren
          </button>
        </Row>
      )}

      {!online ? (
        <Row label="Alle anderen Sitzungen beenden">
          <button
            type="button"
            className="session-panel__button session-panel__button--secondary"
            disabled
          >
            Beenden
          </button>
        </Row>
      ) : confirmingEnd ? (
        <Row label="Wirklich alle anderen Sitzungen beenden?">
          <div className="session-panel__confirm">
            <button
              type="button"
              className="session-panel__button"
              onClick={() => {
                setConfirmingEnd(false);
                endOtherSessions();
              }}
              disabled={endBusy}
            >
              Beenden
            </button>
            <button
              type="button"
              className="session-panel__button session-panel__button--secondary"
              onClick={() => setConfirmingEnd(false)}
              disabled={endBusy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row
          label="Alle anderen Sitzungen beenden"
          description={
            otherCount > 0
              ? `${otherCount} weitere aktive Sitzungen. Diese Sitzung bleibt bestehen — beende sie mit „App sperren“.`
              : 'Keine weiteren aktiven Sitzungen. Diese Sitzung bleibt bestehen — beende sie mit „App sperren“.'
          }
        >
          <button
            type="button"
            className="session-panel__button session-panel__button--secondary"
            onClick={() => setConfirmingEnd(true)}
            disabled={otherCount === 0}
          >
            Beenden
          </button>
        </Row>
      )}
    </SectionCard>
  );
}
