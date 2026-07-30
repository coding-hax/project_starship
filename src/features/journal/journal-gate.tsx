'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { JournalEditor } from './journal-editor';
import { journalLockSnapshot, useJournalLock } from './lock-store';
import './journal-gate.css';

/**
 * The state machine's UI (issue #339). Gesperrt heißt nur: das Journal ist zu,
 * nie die App (ADR-0016) — this component only ever renders inside /journal.
 * `unlocked` renders the actual editor (S3b, #340); `loading`/`setup`/`locked`
 * are unchanged, which is what keeps AC9 (no editor while locked) true for free.
 *
 * `recoveryKey`/`rewrapKey` are UI-only detours (issue #372 AC2/AC4) — the lock
 * state itself has already flipped to `unlocked` by the time either is shown,
 * so both checks run *before* the `state` branches below, not inside them.
 */
export function JournalGate() {
  const { state, error, setup, unlock, unlockWithRecovery, rewrapPassphrase, retry } =
    useJournalLock();
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [rewrapKey, setRewrapKey] = useState<string | null>(null);

  if (state === 'loading') {
    return (
      <div className="journal-gate" data-state="loading">
        <p className="journal-gate__hint">Lädt …</p>
      </div>
    );
  }

  if (recoveryKey !== null) {
    return (
      <JournalRecoveryKeyScreen recoveryKey={recoveryKey} onConfirm={() => setRecoveryKey(null)} />
    );
  }

  if (state === 'setup') {
    return (
      <JournalSetupForm
        onSetup={async (passphrase) => {
          setRecoveryKey(await setup(passphrase));
        }}
      />
    );
  }

  if (state === 'locked') {
    return (
      <JournalUnlockForm
        onUnlock={unlock}
        onUnlockWithRecovery={async (key) => {
          await unlockWithRecovery(key);
          if (journalLockSnapshot().state === 'unlocked') setRewrapKey(key);
        }}
        error={error}
      />
    );
  }

  if (rewrapKey !== null) {
    return (
      <JournalRewrapForm
        onRewrap={async (newPassphrase) => {
          await rewrapPassphrase(rewrapKey, newPassphrase);
          setRewrapKey(null);
        }}
        onSkip={() => setRewrapKey(null)}
      />
    );
  }

  // Kein `setup`, solange unbekannt ist, ob es schon eine Hülle gibt (issue #371):
  // einrichten würde den vorhandenen Schlüssel überschreiben.
  if (state === 'unavailable') {
    return (
      <div className="journal-gate" data-state="unavailable">
        <h2 className="journal-gate__title">Journal nicht erreichbar</h2>
        <p className="journal-gate__hint">{error}</p>
        <button type="button" className="journal-gate__submit" onClick={() => void retry()}>
          Erneut versuchen
        </button>
      </div>
    );
  }

  return (
    <div className="journal-gate" data-state="unlocked">
      <JournalEditor />
    </div>
  );
}

function JournalRecoveryKeyScreen({
  recoveryKey,
  onConfirm,
}: {
  recoveryKey: string;
  onConfirm: () => void;
}) {
  return (
    <div className="journal-gate" data-state="setup-recovery">
      <h2 className="journal-gate__title">Wiederherstellungsschlüssel</h2>
      <p className="journal-gate__hint">
        Speichere ihn jetzt in deinem Passwortmanager. Er wird <strong>nur dieses eine Mal</strong>{' '}
        angezeigt und ist dein einziger Weg zurück, wenn du die Passphrase vergisst.
      </p>
      <code data-testid="journal-recovery-key" className="journal-gate__code">
        {recoveryKey}
      </code>
      <button type="button" className="journal-gate__submit" onClick={onConfirm}>
        Habe ich gespeichert
      </button>
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
        Lege eine Passphrase fest. Sie verschlüsselt das Journal auf diesem Gerät. Direkt danach
        zeigen wir dir einen Wiederherstellungsschlüssel, falls du sie vergisst.
      </p>
      <input
        ref={passphraseRef}
        type="password"
        className="journal-gate__input"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        aria-label="Passphrase"
        placeholder="Passphrase"
        name="new-journal-passphrase"
        autoComplete="new-password"
      />
      <input
        type="password"
        className="journal-gate__input"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        aria-label="Passphrase wiederholen"
        placeholder="Passphrase wiederholen"
        name="new-journal-passphrase-confirm"
        autoComplete="new-password"
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
  onUnlockWithRecovery,
  error,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
  onUnlockWithRecovery: (recoveryKey: string) => Promise<void>;
  error: string | null;
}) {
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryKey, setRecoveryKeyInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'passphrase') {
      await onUnlock(passphrase);
      setPassphrase('');
    } else {
      await onUnlockWithRecovery(recoveryKey);
      setRecoveryKeyInput('');
    }
    inputRef.current?.focus();
  }

  return (
    <form className="journal-gate" data-state="locked" onSubmit={handleSubmit}>
      <h2 className="journal-gate__title">Journal gesperrt</h2>
      <p className="journal-gate__hint">
        {mode === 'passphrase'
          ? 'Gib deine Passphrase ein, um es zu entsperren.'
          : 'Gib deinen Wiederherstellungsschlüssel ein, um es zu entsperren.'}
      </p>
      <input
        ref={inputRef}
        type={mode === 'passphrase' ? 'password' : 'text'}
        className="journal-gate__input"
        value={mode === 'passphrase' ? passphrase : recoveryKey}
        onChange={(event) =>
          mode === 'passphrase'
            ? setPassphrase(event.target.value)
            : setRecoveryKeyInput(event.target.value)
        }
        aria-label={mode === 'passphrase' ? 'Passphrase' : 'Wiederherstellungsschlüssel'}
        placeholder={mode === 'passphrase' ? 'Passphrase' : 'Wiederherstellungsschlüssel'}
        name={mode === 'passphrase' ? 'journal-passphrase' : undefined}
        autoComplete={mode === 'passphrase' ? 'current-password' : 'off'}
      />
      {/* role=status, nie --danger (AC5): falsch ist ein ruhiger Hinweis, kein Fehlerbild —
          gilt für die falsche Passphrase genauso wie für den falschen Recovery-Key. */}
      {error && (
        <p className="journal-gate__message" role="status">
          {error}
        </p>
      )}
      <button type="submit" className="journal-gate__submit">
        Entsperren
      </button>
      <button
        type="button"
        className="journal-gate__link"
        onClick={() => setMode(mode === 'passphrase' ? 'recovery' : 'passphrase')}
      >
        {mode === 'passphrase'
          ? 'Mit Wiederherstellungsschlüssel entsperren'
          : 'Mit Passphrase entsperren'}
      </button>
    </form>
  );
}

function JournalRewrapForm({
  onRewrap,
  onSkip,
}: {
  onRewrap: (newPassphrase: string) => Promise<void>;
  onSkip: () => void;
}) {
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
    await onRewrap(passphrase);
  }

  return (
    <form className="journal-gate" data-state="rewrap" onSubmit={handleSubmit}>
      <h2 className="journal-gate__title">Neue Passphrase festlegen</h2>
      <p className="journal-gate__hint">
        Optional: lege jetzt eine neue Passphrase fest. Deine Einträge bleiben lesbar.
      </p>
      <input
        ref={passphraseRef}
        type="password"
        className="journal-gate__input"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        aria-label="Neue Passphrase"
        placeholder="Neue Passphrase"
        name="new-journal-passphrase"
        autoComplete="new-password"
      />
      <input
        type="password"
        className="journal-gate__input"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        aria-label="Neue Passphrase wiederholen"
        placeholder="Neue Passphrase wiederholen"
        name="new-journal-passphrase-confirm"
        autoComplete="new-password"
      />
      {mismatch && (
        <p className="journal-gate__message" role="status">
          Die Passphrasen stimmen nicht überein.
        </p>
      )}
      <button type="submit" className="journal-gate__submit">
        Festlegen
      </button>
      <button type="button" className="journal-gate__link" onClick={onSkip}>
        Überspringen
      </button>
    </form>
  );
}
