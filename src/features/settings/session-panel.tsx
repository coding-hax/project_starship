'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useOnline } from '@/ui/use-online';
import { journalLock } from '@/features/journal/lock-store';
import './session-panel.css';

export function SessionPanel() {
  const online = useOnline();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function lock() {
    setBusy(true);
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) {
      setBusy(false);
      return;
    }
    await journalLock();
    window.location.assign('/anmelden');
  }

  return (
    <SectionCard title="Sitzung">
      {!online ? (
        <>
          <Row label="App sperren">
            <button type="button" className="session-panel__button" disabled>
              App sperren
            </button>
          </Row>
          <p className="session-panel__hint">Sperren geht nur online.</p>
        </>
      ) : confirming ? (
        <Row label="Wirklich sperren?">
          <div className="session-panel__confirm">
            <button
              type="button"
              className="session-panel__button"
              onClick={lock}
              disabled={busy}
            >
              Sperren
            </button>
            <button
              type="button"
              className="session-panel__button session-panel__button--secondary"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row
          label="App sperren"
          description="Beendet die Sitzung auf diesem Gerät. Zum Öffnen ist danach wieder Face ID nötig."
        >
          <button
            type="button"
            className="session-panel__button"
            onClick={() => setConfirming(true)}
          >
            App sperren
          </button>
        </Row>
      )}
    </SectionCard>
  );
}
