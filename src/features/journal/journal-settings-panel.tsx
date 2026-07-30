'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { useJournalLock } from './lock-store';
import { useJournalPersistPref } from './use-journal-persist-pref';
import './journal-settings-panel.css';

interface JournalRecoverySectionProps {
  reissueRecovery: (passphrase: string) => Promise<string | null>;
}

/**
 * Reissues the recovery key (issue #391) — only rendered while `unlocked`
 * (see `JournalSettingsPanel` below). Mirrors the "only shown once" screen
 * from journal-gate.tsx: passphrase confirmation, then the new key with a
 * warning that the previous one just became invalid.
 */
function JournalRecoverySection({ reissueRecovery }: JournalRecoverySectionProps) {
  const [confirming, setConfirming] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [wrongPassphrase, setWrongPassphrase] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (recoveryKey) {
    return (
      <div className="journal-settings-panel__recovery">
        <p className="journal-settings-panel__hint">
          Speichere ihn jetzt in deinem Passwortmanager. Er ersetzt deinen bisherigen
          Wiederherstellungsschlüssel und wird <strong>nur dieses eine Mal</strong> angezeigt.
        </p>
        <code data-testid="journal-recovery-key" className="journal-settings-panel__code">
          {recoveryKey}
        </code>
        <button
          type="button"
          className="journal-settings-panel__button"
          onClick={() => {
            setRecoveryKey(null);
            setConfirming(false);
          }}
        >
          Habe ich gespeichert
        </button>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await reissueRecovery(passphrase);
    setPassphrase('');
    if (result) {
      setWrongPassphrase(false);
      setRecoveryKey(result);
    } else {
      setWrongPassphrase(true);
      inputRef.current?.focus();
    }
  }

  if (confirming) {
    return (
      <form className="journal-settings-panel__recovery" onSubmit={handleSubmit}>
        <p className="journal-settings-panel__hint">
          Bestätige deine Passphrase, um einen neuen Wiederherstellungsschlüssel auszustellen.
        </p>
        <input
          ref={inputRef}
          type="password"
          className="journal-settings-panel__input"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          aria-label="Passphrase"
          placeholder="Passphrase"
        />
        {/* role=status, kein --danger (Regel 9/AC5-Muster aus journal-gate.tsx):
            eine falsche Passphrase ist ein ruhiger Hinweis, kein Fehlerbild. */}
        {wrongPassphrase && (
          <p className="journal-settings-panel__message" role="status">
            Passphrase stimmt nicht.
          </p>
        )}
        <button type="submit" className="journal-settings-panel__button">
          Neu ausstellen
        </button>
      </form>
    );
  }

  return (
    <Row
      label="Wiederherstellungsschlüssel"
      description="Stellt einen neuen Schlüssel aus — der bisherige wird dabei ungültig."
    >
      <button
        type="button"
        className="journal-settings-panel__button"
        onClick={() => setConfirming(true)}
      >
        Neu ausstellen
      </button>
    </Row>
  );
}

export function JournalSettingsPanel() {
  const { enabled, setEnabled } = useJournalPersistPref();
  const { state, reissueRecovery } = useJournalLock();

  return (
    <SectionCard title="Journal">
      <Row
        label="Auf diesem Gerät entsperrt lassen"
        description="Der Schlüssel bleibt nach einem Neustart auf diesem Gerät gespeichert (nicht extrahierbar) — sonst wird nach jedem Kaltstart erneut nach der Passphrase gefragt."
      >
        <Toggle
          label="Auf diesem Gerät entsperrt lassen"
          checked={enabled}
          onChange={setEnabled}
        />
      </Row>
      {state === 'unlocked' ? (
        <JournalRecoverySection reissueRecovery={reissueRecovery} />
      ) : (
        <p className="journal-settings-panel__hint">
          Entsperre zuerst das Journal, um den Wiederherstellungsschlüssel zu verwalten.
        </p>
      )}
    </SectionCard>
  );
}
