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

interface Snapshot {
  state: JournalLockState;
  error: string | null;
}

type BroadcastMessage = { type: 'unlocked'; dek: CryptoKey } | { type: 'locked' };

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
      if (event.data.type === 'unlocked') {
        dek = event.data.dek;
        setSnapshot({ state: 'unlocked', error: null });
        armAutoLock();
      } else {
        dek = null;
        disarmAutoLock();
        setSnapshot({ state: 'locked', error: null });
      }
    };
  }
  return channel;
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
  getChannel();
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
  setSnapshot({ state: envelope ? 'locked' : 'setup', error: null });
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
