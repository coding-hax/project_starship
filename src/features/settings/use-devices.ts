'use client';

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
    try {
      let credentialsResponse: Response;
      try {
        credentialsResponse = await fetch('/api/auth/credentials');
      } catch {
        // A network-level failure (not a bad status) — e.g. a service-worker
        // controller handoff landing mid-request right after a reload rejects
        // the in-flight fetch instead of answering it (#1224 CI: observed as
        // an unhandled `TypeError: Failed to fetch`, panel stuck on 'loading'
        // forever since nothing downstream ever ran). One immediate retry
        // absorbs that single hiccup without masking a real, repeatable one.
        credentialsResponse = await fetch('/api/auth/credentials');
      }
      if (!credentialsResponse.ok) {
        setPhase('error');
        return;
      }
      const credentialsBody = await credentialsResponse.json();
      setCredentials(credentialsBody.credentials);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
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

  const renameDevice = useCallback(
    async (id: string, label: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/auth/credentials/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: label.trim() || null }),
        });
        if (!response.ok) {
          setError('Umbenennen fehlgeschlagen.');
          return false;
        }
        await load();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return { phase, credentials, busy, error, revoke, renameDevice };
}
