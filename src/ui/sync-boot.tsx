'use client';

import { useEffect } from 'react';
import { setUnauthorizedHandler, startSync } from '@/local/sync';
import { ensurePersistentStorage } from './persist-storage';

/**
 * Wires the sync triggers once the app is mounted: start, foreground, reconnect.
 * Also asks the browser for persistent storage (#52) so IndexedDB is not evicted
 * while the outbox still holds unsynced mutations. Renders nothing — it exists so
 * the shell does not have to be a client component.
 *
 * A hard navigation (not router.push) on 401, so /anmelden runs its own
 * /api/auth/status check fresh rather than inheriting a stale client tree.
 */
export function SyncBoot() {
  useEffect(() => {
    setUnauthorizedHandler(() => window.location.assign('/anmelden'));
    return () => setUnauthorizedHandler(null);
  }, []);
  useEffect(() => startSync(), []);
  useEffect(() => {
    void ensurePersistentStorage();
  }, []);
  return null;
}
