'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { type DeviceCredential, useDevices } from './use-devices';
import './devices-panel.css';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

interface CredentialRowProps {
  credential: DeviceCredential;
  isLastRemaining: boolean;
  disabled: boolean;
  busy: boolean;
  onRevoke: (id: string) => void;
  entering: boolean;
  leaving: boolean;
  onAnimationEnd: () => void;
}

function CredentialRow({
  credential,
  isLastRemaining,
  disabled,
  busy,
  onRevoke,
  entering,
  leaving,
  onAnimationEnd,
}: CredentialRowProps) {
  const [confirming, setConfirming] = useState(false);
  const label = credential.label || 'Unbenanntes Gerät';
  const description = `Hinzugefügt am ${formatDate(credential.createdAt)} · Zuletzt genutzt ${
    credential.lastUsedAt ? formatDate(credential.lastUsedAt) : 'nie'
  }`;

  return (
    <li
      className="devices-panel__item list-motion-item"
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      {confirming ? (
        <Row label={`„${label}“ wirklich widerrufen?`}>
          <div className="devices-panel__confirm">
            <button
              type="button"
              className="devices-panel__button"
              onClick={() => onRevoke(credential.id)}
              disabled={busy}
            >
              Widerrufen
            </button>
            <button
              type="button"
              className="devices-panel__button devices-panel__button--secondary"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row label={label} description={description}>
          <button
            type="button"
            className="devices-panel__button devices-panel__button--secondary"
            onClick={() => setConfirming(true)}
            disabled={disabled}
          >
            Widerrufen
          </button>
        </Row>
      )}
      {isLastRemaining && (
        <p className="devices-panel__hint">Das letzte Gerät kann nicht widerrufen werden.</p>
      )}
    </li>
  );
}

export function DevicesPanel() {
  const online = useOnline();
  const { phase, credentials, otherCount, busy, error, revoke, endOtherSessions } = useDevices();
  const [confirmingSessions, setConfirmingSessions] = useState(false);
  const rows = useListPresence(credentials, (credential) => credential.id);

  if (phase === 'loading') return null;

  return (
    <SectionCard title="Geräte">
      {!online && <p className="devices-panel__hint">Widerrufen geht nur online.</p>}
      {error && <p className="devices-panel__error">{error}</p>}
      <ul className="devices-panel__list">
        {rows.map((row) => (
          <CredentialRow
            key={row.key}
            credential={row.item}
            isLastRemaining={credentials.length <= 1}
            disabled={credentials.length <= 1 || !online}
            busy={busy}
            onRevoke={revoke}
            entering={row.status === 'entering'}
            leaving={row.status === 'leaving'}
            onAnimationEnd={row.onAnimationEnd}
          />
        ))}
      </ul>

      {confirmingSessions ? (
        <Row label="Wirklich alle anderen Sitzungen beenden?">
          <div className="devices-panel__confirm">
            <button
              type="button"
              className="devices-panel__button"
              onClick={() => {
                setConfirmingSessions(false);
                endOtherSessions();
              }}
              disabled={busy}
            >
              Beenden
            </button>
            <button
              type="button"
              className="devices-panel__button devices-panel__button--secondary"
              onClick={() => setConfirmingSessions(false)}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row
          label="Alle anderen Sitzungen beenden"
          description={
            otherCount > 0 ? `${otherCount} weitere aktive Sitzungen` : 'Keine weiteren aktiven Sitzungen'
          }
        >
          <button
            type="button"
            className="devices-panel__button devices-panel__button--secondary"
            onClick={() => setConfirmingSessions(true)}
            disabled={!online || otherCount === 0}
          >
            Beenden
          </button>
        </Row>
      )}
    </SectionCard>
  );
}
