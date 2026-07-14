'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Mode = 'loading' | 'setup' | 'login';

export default function AnmeldenPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((s) => {
        if (s.authenticated) router.replace('/heute');
        else setMode(s.registered ? 'login' : 'setup');
      })
      .catch(() => setError('Server nicht erreichbar.'));
  }, [router]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch('/api/auth/register/options', { method: 'POST' });
      if (!optionsRes.ok) throw new Error('Registrierung ist nicht möglich.');
      const options = await optionsRes.json();

      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, challenge: options.challenge }),
      });
      const result = await verifyRes.json();
      if (!verifyRes.ok || !result.verified) throw new Error(result.error ?? 'Fehlgeschlagen.');

      // Shown once. If it is lost, it is lost.
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else router.replace('/heute');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler.');
    } finally {
      setBusy(false);
    }
  }

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

      router.replace('/heute');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCode) {
    return (
      <main className="auth">
        <h1>Wiederherstellungscode</h1>
        <p>
          Speichere ihn jetzt in deinem Passwortmanager. Er wird{' '}
          <strong>nur dieses eine Mal</strong> angezeigt und ist dein einziger Weg zurück, wenn du
          den Passkey verlierst.
        </p>
        <code data-testid="recovery-code" className="auth__code">
          {recoveryCode}
        </code>
        <button className="auth__button" onClick={() => router.replace('/heute')}>
          Habe ich gespeichert
        </button>
      </main>
    );
  }

  return (
    <main className="auth">
      <h1>Starship</h1>
      {mode === 'loading' && <p>Einen Moment…</p>}

      {mode === 'setup' && (
        <>
          <p>Richte deinen Passkey ein. Danach genügt Face ID.</p>
          <button className="auth__button" onClick={register} disabled={busy}>
            {busy ? 'Einen Moment…' : 'Passkey einrichten'}
          </button>
        </>
      )}

      {mode === 'login' && (
        <>
          <p>Melde dich mit deinem Passkey an.</p>
          <button className="auth__button" onClick={login} disabled={busy}>
            {busy ? 'Einen Moment…' : 'Mit Passkey anmelden'}
          </button>
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
