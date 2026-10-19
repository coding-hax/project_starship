'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { PageFace } from '@/ui/faces';
import { OfflineNotice } from '@/ui/offline-notice';
import { useOnline } from '@/ui/use-online';

type Mode = 'loading' | 'no-invite' | 'login';

/**
 * @simplewebauthn/browser v13 wraps the original DOMException in `.cause` — this
 * unwraps it (or falls back to a plain DOMException) so `NotAllowedError` (user
 * cancelled) and `InvalidStateError` (this device already holds the passkey) can
 * be told apart from every other ceremony failure.
 */
function ceremonyErrorName(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof DOMException) return cause.name;
  if (error instanceof DOMException) return error.name;
  return undefined;
}

function recoveryErrorFor(status: number): string {
  if (status === 429) return 'Zu viele Versuche. Bitte kurz warten.';
  if (status === 403) return 'Recovery-Code ungültig oder bereits verbraucht.';
  return 'Server nicht erreichbar.';
}

export default function AnmeldenPage() {
  const router = useRouter();
  const online = useOnline();
  const recoveryInputId = useId();
  const [mode, setMode] = useState<Mode>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((s) => {
        if (s.authenticated) router.replace('/uebersicht');
        else setMode(s.registered ? 'login' : 'no-invite');
      })
      .catch(() => setError('Server nicht erreichbar.'));
  }, [router]);

  async function login() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch('/api/auth/login/options', { method: 'POST' });
      const options = await optionsRes.json();

      const response = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, challenge: options.challenge }),
      });
      const result = await verifyRes.json();
      if (!verifyRes.ok || !result.verified) throw new Error(result.error ?? 'Fehlgeschlagen.');

      router.replace('/uebersicht');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler.');
    } finally {
      setBusy(false);
    }
  }

  function closeRecovery() {
    setShowRecovery(false);
    setRecoveryInput('');
    setError(null);
  }

  async function registerWithRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch('/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryCode: recoveryInput.trim() }),
      });
      if (!optionsRes.ok) {
        setError(recoveryErrorFor(optionsRes.status));
        return;
      }
      const options = await optionsRes.json();

      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch (e) {
        const name = ceremonyErrorName(e);
        if (name === 'NotAllowedError') return; // user cancelled — not an error
        if (name === 'InvalidStateError') {
          setError('Auf diesem Gerät gibt es den Passkey schon.');
          return;
        }
        setError('Server nicht erreichbar.');
        return;
      }

      const verifyRes = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, challenge: options.challenge }),
      });
      const result = await verifyRes.json();
      if (!verifyRes.ok || !result.verified) {
        setError(recoveryErrorFor(verifyRes.status));
        return;
      }

      // Recovery never mints a fresh code (register/verify:firstCredential is
      // always false here) — straight to the app, no code screen.
      router.replace('/uebersicht');
    } catch {
      setError('Server nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth" data-ground="anmelden">
      <div className="auth__title-row">
        <PageFace face="anmelden" />
        <h1>Willkommen zurück</h1>
      </div>
      {mode === 'loading' && <p>Einen Moment…</p>}

      {mode === 'no-invite' && (
        <p>Diese App ist nur über einen Einladungs-Link erreichbar.</p>
      )}

      {mode === 'login' && (
        <>
          <p>Melde dich mit deinem Passkey an.</p>
          <button className="auth__button" onClick={login} disabled={busy}>
            {busy ? 'Einen Moment…' : 'Mit Passkey anmelden'}
          </button>

          {!showRecovery && (
            <button
              type="button"
              className="auth__recovery-toggle"
              onClick={() => setShowRecovery(true)}
              disabled={busy}
            >
              Neues Gerät? Mit Recovery-Code anmelden
            </button>
          )}

          {showRecovery && (
            <form className="auth__recovery-form" onSubmit={registerWithRecovery}>
              <label htmlFor={recoveryInputId} className="auth__recovery-label">
                Recovery-Code
              </label>
              <input
                id={recoveryInputId}
                type="text"
                className="auth__input"
                value={recoveryInput}
                onChange={(event) => setRecoveryInput(event.target.value)}
                required
                autoFocus
              />
              {!online && <OfflineNotice>Geht nur online.</OfflineNotice>}
              <div className="auth__recovery-actions">
                <button
                  type="submit"
                  className="auth__button"
                  disabled={busy || !online}
                >
                  {busy ? 'Einen Moment…' : 'Gerät anmelden'}
                </button>
                <button
                  type="button"
                  className="auth__button auth__button--secondary"
                  onClick={closeRecovery}
                  disabled={busy}
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="auth__error">
          {error}
        </p>
      )}
    </main>
  );
}
