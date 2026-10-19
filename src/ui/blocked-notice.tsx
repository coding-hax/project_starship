'use client';

import { useSyncExternalStore } from 'react';
import { isBlocked, subscribeBlocked } from '@/local/account-isolation';
import { OfflineNotice } from './offline-notice';

function getServerSnapshot(): boolean {
  return false;
}

/**
 * AK5 (#1201): a blocked account's sync stops with a calm note instead of the
 * offline hint, never a retry loop. Reuses `OfflineNotice`'s shape (`role="status"`,
 * same surface/ink) rather than a second near-identical banner — the two states
 * never show at once, so there is nothing to tell apart visually.
 */
export function BlockedNotice() {
  const blocked = useSyncExternalStore(subscribeBlocked, isBlocked, getServerSnapshot);
  if (!blocked) return null;

  return <OfflineNotice>Dieses Konto wurde gesperrt. Melde dich bei der Verwaltung.</OfflineNotice>;
}
