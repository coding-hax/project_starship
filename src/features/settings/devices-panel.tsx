'use client';

import { useId, useState, type FormEvent } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { type DeviceCredential, useDevices } from './use-devices';
import './devices-panel.css';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

interface CredentialRowProps {
  credential: DeviceCredential;
  isLastRemaining: boolean;
  disabled: boolean;
  busy: boolean;
  online: boolean;
  onRevoke: (id: string, isCurrent: boolean) => void;
  onRename: (id: string, label: string) => Promise<boolean>;
  entering: boolean;
  leaving: boolean;
  onAnimationEnd: () => void;
}

function CredentialRow({
  credential,
  isLastRemaining,
  disabled,
  busy,
  online,
  onRevoke,
  onRename,
  entering,
  leaving,
  onAnimationEnd,
}: CredentialRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(credential.label ?? '');
  const nameInputId = useId();
  const label = credential.label || 'Unbenanntes Gerät';
  const description = `Hinzugefügt am ${formatDate(credential.createdAt)} · Zuletzt genutzt ${
    credential.lastUsedAt ? formatDate(credential.lastUsedAt) : 'nie'
  }`;
  const rowLabel = credential.current ? (
    <>
      {label} <span className="devices-panel__current-badge">Dieses Gerät</span>
    </>
  ) : (
    label
  );

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const succeeded = await onRename(credential.id, name);
    if (succeeded) setRenaming(false);
  }

  return (
    <li
      className="devices-panel__item list-motion-item"
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      {confirming ? (
        <Row
          label={
            credential.current
              ? 'Das ist dieses Gerät — du wirst abgemeldet'
              : `„${label}“ wirklich widerrufen?`
          }
        >
          <div className="devices-panel__confirm">
            <button
              type="button"
              className="devices-panel__button"
              onClick={() => onRevoke(credential.id, credential.current)}
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
      ) : renaming ? (
        <form className="devices-panel__add-form" onSubmit={handleRenameSubmit}>
          <label htmlFor={nameInputId} className="devices-panel__add-label">
            Neuer Name
          </label>
          <input
            id={nameInputId}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="z. B. iPhone"
            className="devices-panel__add-input"
            autoFocus
          />
          <div className="devices-panel__confirm">
            <button type="submit" className="devices-panel__button" disabled={busy}>
              Speichern
            </button>
            <button
              type="button"
              className="devices-panel__button devices-panel__button--secondary"
              onClick={() => {
                setName(credential.label ?? '');
                setRenaming(false);
              }}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : (
        <Row label={rowLabel} description={description}>
          <div className="devices-panel__confirm">
            <button
              type="button"
              className="devices-panel__button devices-panel__button--secondary"
              onClick={() => setRenaming(true)}
              disabled={!online || busy}
            >
              Umbenennen
            </button>
            <button
              type="button"
              className="devices-panel__button devices-panel__button--secondary"
              onClick={() => setConfirming(true)}
              disabled={disabled}
            >
              Widerrufen
            </button>
          </div>
        </Row>
      )}
      {isLastRemaining && (
        <p className="devices-panel__hint">Das letzte Gerät kann nicht widerrufen werden.</p>
      )}
    </li>
  );
}

function AddDeviceRow({
  online,
  busy,
  onAdd,
}: {
  online: boolean;
  busy: boolean;
  onAdd: (label: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const nameInputId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const succeeded = await onAdd(name);
    if (succeeded) {
      setAdding(false);
      setName('');
    }
  }

  if (adding) {
    return (
      <form className="devices-panel__add-form" onSubmit={handleSubmit}>
        <label htmlFor={nameInputId} className="devices-panel__add-label">
          Gerätename (optional)
        </label>
        <input
          id={nameInputId}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="z. B. iPhone"
          className="devices-panel__add-input"
          autoFocus
        />
        <div className="devices-panel__confirm">
          <button type="submit" className="devices-panel__button" disabled={busy}>
            Hinzufügen
          </button>
          <button
            type="button"
            className="devices-panel__button devices-panel__button--secondary"
            onClick={() => setAdding(false)}
            disabled={busy}
          >
            Abbrechen
          </button>
        </div>
      </form>
    );
  }

  return (
    <Row label="Gerät hinzufügen">
      <button
        type="button"
        className="devices-panel__button devices-panel__button--secondary"
        onClick={() => setAdding(true)}
        disabled={!online || busy}
      >
        Gerät hinzufügen
      </button>
    </Row>
  );
}

export function DevicesPanel() {
  const online = useOnline();
  const { phase, credentials, busy, error, revoke, renameDevice, addDevice } = useDevices();
  const rows = useListPresence(credentials, (credential) => credential.id);

  if (phase === 'loading') return null;

  return (
    <SectionCard title="Geräte" className="devices-panel">
      {!online && <p className="devices-panel__hint">Geht nur online.</p>}
      {error && <p className="devices-panel__error">{error}</p>}
      <ul className="devices-panel__list">
        {rows.map((row) => (
          <CredentialRow
            key={row.key}
            credential={row.item}
            isLastRemaining={credentials.length <= 1}
            disabled={credentials.length <= 1 || !online}
            busy={busy}
            online={online}
            onRevoke={revoke}
            onRename={renameDevice}
            entering={row.status === 'entering'}
            leaving={row.status === 'leaving'}
            onAnimationEnd={row.onAnimationEnd}
          />
        ))}
      </ul>

      <AddDeviceRow online={online} busy={busy} onAdd={addDevice} />
    </SectionCard>
  );
}
