'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useJournalLock } from './lock-store';
import './journal-gate.css';

/**
 * The state machine's UI (issue #339). `unlocked` is a placeholder — the editor
 * itself is S3b (#340). Gesperrt heißt nur: das Journal ist zu, nie die App
 * (ADR-0016) — this component only ever renders inside /journal.
 */
export function JournalGate() {
  const { state, error, setup, unlock } = useJournalLock();

  if (state === 'loading') {
    return (
      <div className="journal-gate" data-state="loading">
        <p className="journal-gate__hint">Lädt …</p>
      </div>
    );
  }

  if (state === 'setup') {
    return <JournalSetupForm onSetup={setup} />;
  }

  if (state === 'locked') {
    return <JournalUnlockForm onUnlock={unlock} error={error} />;
  }

  return (
    <div className="journal-gate" data-state="unlocked">
      <p className="journal-gate__hint">
        Journal ist entsperrt. Der Editor kommt in einem weiteren Schritt.
      </p>
    </div>
  );
}

function JournalSetupForm({ onSetup }: { onSetup: (passphrase: string) => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const passphraseRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passphraseRef.current?.focus();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passphrase.length === 0 || passphrase !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    await onSetup(passphrase);
  }

  return (
    <form className="journal-gate" data-state="setup" onSubmit={handleSubmit}>
      <h2 className="journal-gate__title">Journal einrichten</h2>
      <p className="journal-gate__hint">
        Lege eine Passphrase fest. Sie verschlüsselt das Journal auf diesem Gerät — es gibt
        noch keine Wiederherstellung, wenn du sie vergisst.
      </p>
      <input
        ref={passphraseRef}
        type="password"
        className="journal-gate__input"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        aria-label="Passphrase"
        placeholder="Passphrase"
      />
      <input
        type="password"
        className="journal-gate__input"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        aria-label="Passphrase wiederholen"
        placeholder="Passphrase wiederholen"
      />
      {mismatch && (
        <p className="journal-gate__message" role="status">
          Die Passphrasen stimmen nicht überein.
        </p>
      )}
      <button type="submit" className="journal-gate__submit">
        Einrichten
      </button>
    </form>
  );
}

function JournalUnlockForm({
  onUnlock,
  error,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
  error: string | null;
}) {
  const [passphrase, setPassphrase] = useState('');
  const passphraseRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passphraseRef.current?.focus();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onUnlock(passphrase);
    setPassphrase('');
    passphraseRef.current?.focus();
  }

  return (
    <form className="journal-gate" data-state="locked" onSubmit={handleSubmit}>
      <h2 className="journal-gate__title">Journal gesperrt</h2>
      <p className="journal-gate__hint">Gib deine Passphrase ein, um es zu entsperren.</p>
      <input
        ref={passphraseRef}
        type="password"
        className="journal-gate__input"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        aria-label="Passphrase"
        placeholder="Passphrase"
      />
      {/* role=status, nie --danger (AC3): falsch ist ein ruhiger Hinweis, kein Fehlerbild. */}
      {error && (
        <p className="journal-gate__message" role="status">
          {error}
        </p>
      )}
      <button type="submit" className="journal-gate__submit">
        Entsperren
      </button>
    </form>
  );
}
