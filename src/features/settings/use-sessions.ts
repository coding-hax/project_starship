'use client';

import { useCallback, useEffect, useState } from 'react';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Talks to /api/auth/sessions directly rather than through src/local/ — auth is
 * server-synchronous, not an outbox mutation (same as use-devices.ts).
 */
export function useSessions() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [otherCount, setOtherCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/auth/sessions');
    if (!response.ok) {
      setPhase('error');
      return;
    }
    const body = await response.json();
    setOtherCount(body.otherCount);
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

  const endOtherSessions = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/sessions', { method: 'DELETE' });
      if (!response.ok) {
        setError('Beenden fehlgeschlagen.');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  return { phase, otherCount, busy, error, endOtherSessions, reload: load };
}
