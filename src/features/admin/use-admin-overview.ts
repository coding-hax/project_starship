'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AccountsOverview } from './accounts-overview';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Talks to /api/admin/accounts directly, same reasoning as use-sessions.ts: auth
 * (and, since #1203, the admin overview) is server-synchronous, not an outbox
 * mutation.
 */
export function useAdminOverview() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [overview, setOverview] = useState<AccountsOverview | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const response = await fetch('/api/admin/accounts');
      if (!response.ok) {
        setPhase('error');
        return;
      }
      setOverview(await response.json());
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, []);

  // queueMicrotask, not a direct call: react-hooks/set-state-in-effect flags a
  // synchronous call to a setState-calling function from the effect body itself
  // (same pattern as use-sessions.ts/quick-add.tsx).
  useEffect(() => {
    queueMicrotask(() => {
      load();
    });
  }, [load]);

  return { phase, overview, reload: load };
}
