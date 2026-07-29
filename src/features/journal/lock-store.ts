'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { createEnvelope, openEnvelope } from '@/crypto/envelope';
import { WrongPassphraseError } from '@/crypto/errors';
import { clearPersistedDek, getPersistedDek, persistDek } from './dek-session';
import { readEnvelope, writeEnvelope } from './journal-keys';
import { readJournalPersistPref, subscribeJournalPersistPref } from './use-journal-persist-pref';

export type JournalLockState = 'loading' | 'setup' | 'locked' | 'unlocked';

/**
 * The inactivity window (issue #339 AC6) — the one named constant the auto-lock
 * timer reads, instead of a number scattered across the file.
 */
export const AUTO_LOCK_MS = 15 * 60 * 1000;

const BROADCAST_CHANNEL_NAME = 'starship:journal-lock';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const;
/** How long a freshly opened tab waits for an already-unlocked tab to answer
 * its `request` before falling back to `locked` (AC7). Same-process
 * `BroadcastChannel` round trips in well under this. */
const SHARE_REQUEST_TIMEOUT_MS = 150;

interface Snapshot {
  state: JournalLockState;
  error: string | null;
}

type BroadcastMessage =
  | { type: 'unlocked'; dek: CryptoKey }
  | { type: 'locked' }
  /** A tab that just opened, asking whether anyone is already unlocked. */
  | { type: 'request' };

const SERVER_SNAPSHOT: Snapshot = { state: 'loading', error: null };

/** The unpacked DEK never lives in React state (ADR-0016) — only here, in memory. */
let dek: CryptoKey | null = null;
let current: Snapshot = SERVER_SNAPSHOT;
let channel: BroadcastChannel | null = null;
let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function setSnapshot(next: Snapshot) {
  current = next;
  notify();
}

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      const message = event.data;
      if (message.type === 'unlocked') {
        dek = message.dek;
        setSnapshot({ state: 'unlocked', error: null });
        armAutoLock();
      } else if (message.type === 'locked') {
        dek = null;
        disarmAutoLock();
        setSnapshot({ state: 'locked', error: null });
      } else if (dek) {
        // Another tab just opened and is asking — only an unlocked tab replies.
        channel?.postMessage({ type: 'unlocked', dek } satisfies BroadcastMessage);
      }
    };
  }
  return channel;
}

/**
 * Asks any already-unlocked tab for its DEK (AC7) — a tab that opens after
 * another is already unlocked must not ask for the passphrase again. Resolves
 * `null` if nothing answers in time, i.e. no other tab is currently unlocked.
 */
function requestSharedDek(ch: BroadcastChannel): Promise<CryptoKey | null> {
  return new Promise((resolve) => {
    let settled = false;
    const onMessage = (event: MessageEvent<BroadcastMessage>) => {
      if (event.data.type === 'unlocked' && !settled) {
        settled = true;
        ch.removeEventListener('message', onMessage);
        resolve(event.data.dek);
      }
    };
    ch.addEventListener('message', onMessage);
    ch.postMessage({ type: 'request' } satisfies BroadcastMessage);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      ch.removeEventListener('message', onMessage);
      resolve(null);
    }, SHARE_REQUEST_TIMEOUT_MS);
  });
}

function onActivity() {
  if (current.state === 'unlocked' && !readJournalPersistPref()) {
    scheduleAutoLockTimer();
  }
}

function scheduleAutoLockTimer() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => {
    void journalLock();
  }, AUTO_LOCK_MS);
}

/** Opt-in ON disables auto-lock on this device entirely (AC5 vs AC6). */
function armAutoLock() {
  disarmAutoLock();
  if (readJournalPersistPref()) return;
  scheduleAutoLockTimer();
  for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity);
}

function disarmAutoLock() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity);
}

/** Toggling the opt-in while already unlocked takes effect immediately, without
 * waiting for the next unlock (issue #339 AC5). */
function onPersistPrefChange() {
  if (current.state !== 'unlocked') return;
  if (readJournalPersistPref()) {
    if (dek) void persistDek(dek);
  } else {
    void clearPersistedDek();
  }
  armAutoLock();
}

async function initialize(): Promise<void> {
  const ch = getChannel();
  subscribeJournalPersistPref(onPersistPrefChange);

  const persisted = await getPersistedDek();
  // A direct action (journalSetup/journalUnlock via the E2E bridge) may already
  // have resolved the state while this await was in flight.
  if (current.state !== 'loading') return;
  if (persisted) {
    dek = persisted;
    setSnapshot({ state: 'unlocked', error: null });
    armAutoLock();
    return;
  }

  const envelope = await readEnvelope();
  if (current.state !== 'loading') return;
  if (!envelope) {
    setSnapshot({ state: 'setup', error: null });
    return;
  }

  const shared = await requestSharedDek(ch);
  if (current.state !== 'loading') return;
  if (shared) {
    dek = shared;
    setSnapshot({ state: 'unlocked', error: null });
    armAutoLock();
    return;
  }

  setSnapshot({ state: 'locked', error: null });
}

function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

export async function journalSetup(passphrase: string): Promise<void> {
  const envelope = await createEnvelope(passphrase);
  const opened = await openEnvelope(envelope, passphrase);
  await writeEnvelope(envelope);
  dek = opened;
  setSnapshot({ state: 'unlocked', error: null });
  getChannel().postMessage({ type: 'unlocked', dek: opened } satisfies BroadcastMessage);
  armAutoLock();
  if (readJournalPersistPref()) await persistDek(opened);
}

export async function journalUnlock(passphrase: string): Promise<void> {
  const envelope = await readEnvelope();
  if (!envelope) return;

  try {
    const opened = await openEnvelope(envelope, passphrase);
    dek = opened;
    setSnapshot({ state: 'unlocked', error: null });
    getChannel().postMessage({ type: 'unlocked', dek: opened } satisfies BroadcastMessage);
    armAutoLock();
    if (readJournalPersistPref()) await persistDek(opened);
  } catch (error) {
    if (!(error instanceof WrongPassphraseError)) throw error;
    // Ruhige Meldung (AC3) — die Fehlermeldung selbst verrät nie, wie falsch die
    // Passphrase war, nur dass sie es war.
    setSnapshot({ state: 'locked', error: error.message });
  }
}

export async function journalLock(): Promise<void> {
  dek = null;
  disarmAutoLock();
  await clearPersistedDek();
  setSnapshot({ state: 'locked', error: null });
  getChannel().postMessage({ type: 'locked' } satisfies BroadcastMessage);
}

export function journalLockSnapshot(): Snapshot {
  return current;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot(): Snapshot {
  return current;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

export function useJournalLock() {
  useEffect(() => {
    void ensureInitialized();
  }, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    state: snapshot.state,
    error: snapshot.error,
    setup: journalSetup,
    unlock: journalUnlock,
    lock: journalLock,
  };
}
