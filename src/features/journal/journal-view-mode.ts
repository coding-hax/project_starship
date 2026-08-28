'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the journal is in search mode (issue #700 AK5/AK6). A tiny module
 * store in the same shape as lock-store.ts (`useSyncExternalStore` + a
 * module variable + a listener set, no new dependency): the lupe in the
 * title row (`JournalSearchToggle`, outside the gate) and the search field +
 * editor (inside the gate) live in different subtrees, so a shared module
 * store — not lifted React state — is what lets one open what the other
 * renders.
 *
 * Reset to `false` whenever the journal locks (see `JournalSearchToggle`) —
 * otherwise a re-unlock would drop straight back into search mode while the
 * decryption cache is still empty.
 */
let active = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot() {
  return active;
}

/** The server never has a search mode open — same reasoning as lock-store.ts's
 * `SERVER_SNAPSHOT`. */
function getServerSnapshot() {
  return false;
}

export function openJournalSearch() {
  if (active) return;
  active = true;
  notify();
}

export function closeJournalSearch() {
  if (!active) return;
  active = false;
  notify();
}

export function useJournalSearchMode() {
  const isActive = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { active: isActive, open: openJournalSearch, close: closeJournalSearch };
}
