'use client';

import { useEffect } from 'react';
import { startSync } from '@/local/sync';

/**
 * Wires the sync triggers once the app is mounted: start, foreground, reconnect.
 * Renders nothing — it exists so the shell does not have to be a client component.
 */
export function SyncBoot() {
  useEffect(() => startSync(), []);
  return null;
}
