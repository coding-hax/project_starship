'use client';

import { liveQuery } from 'dexie';
import { useEffect, useRef, useState } from 'react';
import { db } from '@/local/dexie';
import { overSyncErrorThreshold } from '@/local/outbox';
import { sync } from '@/local/sync';
import { Toast } from './toast';

/**
 * Surfaces a sync error once a queued mutation has failed SYNC_ERROR_THRESHOLD
 * times in a row (#182) — otherwise a poison mutation or a down server retries
 * silently forever, 30s at a time, with no sign anything is wrong. A dismissal
 * stays dismissed until the condition falls back below the threshold and rises
 * again — no re-popping mid-incident, but a fresh incident is shown fresh.
 */
export function SyncStatus() {
  const [overThreshold, setOverThreshold] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wasOverRef = useRef(false);

  useEffect(() => {
    const subscription = liveQuery(() => db.outbox.toArray()).subscribe({
      next: (entries) => {
        const over = overSyncErrorThreshold(entries);
        if (over && !wasOverRef.current) setDismissed(false);
        wasOverRef.current = over;
        setOverThreshold(over);
      },
      error: (error) => console.error('[sync-status] live query failed', error),
    });

    return () => subscription.unsubscribe();
  }, []);

  if (!overThreshold || dismissed) return null;

  return (
    <Toast
      variant="error"
      message="Änderungen konnten nicht synchronisiert werden."
      actionLabel="Erneut versuchen"
      onAction={() => void sync()}
      onDismiss={() => setDismissed(true)}
    />
  );
}
