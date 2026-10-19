'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageFace } from '@/ui/faces';

/**
 * Same status codes `register/options`/`register/verify` answer with for an
 * invite-backed ceremony. 403 covers both "unknown token" and "expired/used
 * token" — AK4 requires they read identically, so this never tries to tell
 * them apart either.
 */
function einladungErrorFor(status: number): string {
  if (status === 429) return 'Zu viele Versuche. Bitte kurz warten.';
  if (status === 403) return 'Diese Einladung ist ungültig oder abgelaufen.';
  return 'Server nicht erreichbar.';
}

export default function EinladungPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  async function redeem() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch('/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: token }),
      });
      if (!optionsRes.ok) {
        setError(einladungErrorFor(optionsRes.status));
        return;
      }
      const options = await optionsRes.json();

      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, challenge: options.challenge }),
      });
      const result = await verifyRes.json();
      if (!verifyRes.ok || !result.verified) {
        setError(einladungErrorFor(verifyRes.status));
        return;
      }

      // Shown once — only the bootstrap admin's invite ever produces one
      // (register/verify: firstCredential). If it is lost, it is lost.
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else router.replace('/uebersicht');
    } catch {
      setError('Server nicht erreichbar.');
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
        <PageFace face="anmelden" />
        <h1>Willkommen</h1>
      </div>
      <p>Du wurdest eingeladen. Richte deinen Passkey ein, danach genügt Face ID.</p>
      <button className="auth__button" onClick={redeem} disabled={busy}>
        {busy ? 'Einen Moment…' : 'Passkey einrichten'}
      </button>
      {error && (
        <p role="alert" className="auth__error">
          {error}
        </p>
      )}
    </main>
  );
}
