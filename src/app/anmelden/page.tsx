'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { PageFace } from '@/ui/faces';

type Mode = 'loading' | 'setup' | 'login';

export default function AnmeldenPage() {
  const router = useRouter();
  const deviceNameInputId = useId();
  const [mode, setMode] = useState<Mode>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((s) => {
        if (s.authenticated) router.replace('/uebersicht');
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
        body: JSON.stringify({
          response,
          challenge: options.challenge,
          label: deviceName.trim() || undefined,
        }),
      });
      const result = await verifyRes.json();
      if (!verifyRes.ok || !result.verified) throw new Error(result.error ?? 'Fehlgeschlagen.');

      // Shown once. If it is lost, it is lost.
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else router.replace('/uebersicht');
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

      router.replace('/uebersicht');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCode) {
    return (
      <main className="auth" data-ground="anmelden">
        <h1>Wiederherstellungscode</h1>
        <p>
          Speichere ihn jetzt in deinem Passwortmanager. Er wird{' '}
          <strong>nur dieses eine Mal</strong> angezeigt und ist dein einziger Weg zurück, wenn du
          den Passkey verlierst.
        </p>
        <code data-testid="recovery-code" className="auth__code">
          {recoveryCode}
        </code>
        <button className="auth__button" onClick={() => router.replace('/uebersicht')}>
          Habe ich gespeichert
        </button>
      </main>
    );
  }

  return (
    <main className="auth" data-ground="anmelden">
      <div className="auth__title-row">
        <h1>Starship</h1>
        <PageFace face="anmelden" />
      </div>
      {mode === 'loading' && <p>Einen Moment…</p>}

      {mode === 'setup' && (
        <>
          <p>Richte deinen Passkey ein. Danach genügt Face ID.</p>
          <label htmlFor={deviceNameInputId} className="auth__label">
            Gerätename (optional)
          </label>
          <input
            id={deviceNameInputId}
            type="text"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="z. B. iPhone"
            className="auth__input"
            disabled={busy}
          />
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
