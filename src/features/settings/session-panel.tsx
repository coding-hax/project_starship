'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useOnline } from '@/ui/use-online';
import { journalLock } from '@/features/journal/lock-store';
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
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) {
      setLockBusy(false);
      return;
    }
    await journalLock();
    window.location.assign('/anmelden');
  }

  return (
    <SectionCard title="Sitzung" className="session-panel">
      {!online && <p className="session-panel__hint">Geht nur online.</p>}
      {endError && <p className="session-panel__error">{endError}</p>}

      {!online ? (
        <Row label="App sperren">
          <button type="button" className="session-panel__button" disabled>
            App sperren
          </button>
        </Row>
      ) : confirmingLock ? (
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
