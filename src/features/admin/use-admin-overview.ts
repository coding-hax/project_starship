'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountOverviewRow, AccountsOverview } from './accounts-overview';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Talks to /api/admin/accounts directly, same reasoning as use-sessions.ts: auth
 * (and, since #1203, the admin overview) is server-synchronous, not an outbox
 * mutation.
 */
export function useAdminOverview() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  // The mount effect's `load()` and a post-action `reload()` can overlap (dev-mode
  // double-invokes the mount effect; a slow aggregation query makes which one
  // resolves last unpredictable). Without this guard, whichever response lands
  // last wins and can silently revert a just-confirmed block/unblock back to its
  // pre-action state — a real race, not a timing issue to paper over with a
  // longer timeout. Only the most recently *issued* call may ever commit state.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setPhase('loading');
    try {
      const response = await fetch('/api/admin/accounts');
      if (id !== requestId.current) return;
      if (!response.ok) {
        setPhase('error');
        return;
      }
      const body = await response.json();
      if (id !== requestId.current) return;
      setOverview(body);
      setPhase('ready');
    } catch {
      if (id === requestId.current) setPhase('error');
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

  /**
   * Applies a status the caller already knows for certain (block/unblock just
   * confirmed by its own 200) without waiting for a follow-up `reload()` — a
   * block/unblock toggle's resulting status is fully determined by its own
   * response, so there's no reason the UI should depend on a second, separately
   * racing GET to learn something it was already told.
   */
  const setAccountStatus = useCallback((id: string, status: AccountOverviewRow['status']) => {
    setOverview((prev) =>
      prev ? { ...prev, accounts: prev.accounts.map((a) => (a.id === id ? { ...a, status } : a)) } : prev,
    );
  }, []);

  return { phase, overview, reload: load, setAccountStatus };
}
