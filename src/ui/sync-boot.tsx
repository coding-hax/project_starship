'use client';

import { useEffect } from 'react';
import { startSync } from '@/local/sync';
import { ensurePersistentStorage } from './persist-storage';

/**
 * Wires the sync triggers once the app is mounted: start, foreground, reconnect.
 * Also asks the browser for persistent storage (#52) so IndexedDB is not evicted
 * while the outbox still holds unsynced mutations. Renders nothing — it exists so
 * the shell does not have to be a client component.
 */
export function SyncBoot() {
  useEffect(() => startSync(), []);
  useEffect(() => {
    void ensurePersistentStorage();
  }, []);
  return null;
}
