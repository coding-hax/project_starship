'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';

export interface DeviceCredential {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
}

type Phase = 'loading' | 'ready' | 'error';

/**
 * Talks to /api/auth/* directly rather than through src/local/ — auth is
 * server-synchronous, not an outbox mutation (same as session-panel.tsx's logout).
 */
export function useDevices() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [credentials, setCredentials] = useState<DeviceCredential[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const credentialsResponse = await fetch('/api/auth/credentials');
    if (!credentialsResponse.ok) {
      setPhase('error');
      return;
    }
    const credentialsBody = await credentialsResponse.json();
    setCredentials(credentialsBody.credentials);
    setPhase('ready');
  }, []);

  // queueMicrotask, not a direct call: react-hooks/set-state-in-effect flags a
  // synchronous call to a setState-calling function from the effect body itself
  // (see quick-add.tsx for the same pattern).
  useEffect(() => {
    queueMicrotask(() => {
      load();
    });
  }, [load]);

  const revoke = useCallback(
    async (id: string, isCurrent: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/auth/credentials/${id}`, { method: 'DELETE' });
        if (response.status === 409) {
          const body = await response.json().catch(() => null);
          setError(body?.error ?? 'Das letzte Gerät kann nicht widerrufen werden.');
          return;
        }
        if (!response.ok) {
          setError('Widerrufen fehlgeschlagen.');
          return;
        }
        if (isCurrent) {
          // The cascade already ended this device's own session — a load() would
          // just run into a 401. Send it straight to the login screen instead.
          window.location.assign('/anmelden');
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const addDevice = useCallback(
    async (label: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const optionsResponse = await fetch('/api/auth/register/options', { method: 'POST' });
        if (!optionsResponse.ok) {
          setError('Gerät hinzufügen fehlgeschlagen.');
          return false;
        }
        const options = await optionsResponse.json();

        const response = await startRegistration({ optionsJSON: options });
        const verifyResponse = await fetch('/api/auth/register/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            response,
            challenge: options.challenge,
            label: label.trim() || undefined,
          }),
        });
        const result = await verifyResponse.json();
        if (!verifyResponse.ok || !result.verified) {
          setError('Gerät hinzufügen fehlgeschlagen.');
          return false;
        }
        await load();
        return true;
      } catch {
        setError('Gerät hinzufügen fehlgeschlagen.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return { phase, credentials, busy, error, revoke, addDevice };
}
