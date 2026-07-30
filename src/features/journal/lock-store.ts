'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { openEnvelope } from '@/crypto/envelope';
import { WrongPassphraseError } from '@/crypto/errors';
import {
  createEnvelopesWithRecovery,
  openEnvelopeWithRecovery,
  reissueRecovery,
  rewrapPassphrase,
} from '@/crypto/journal';
import { pull } from '@/local/sync';
import { clearPersistedDek, getPersistedDek, persistDek } from './dek-session';
import {
  readEnvelope,
  readRecoveryEnvelope,
  writeEnvelope,
  writeEnvelopes,
  writeRecoveryEnvelope,
} from './journal-keys';
import { readJournalPersistPref, subscribeJournalPersistPref } from './use-journal-persist-pref';

export type JournalLockState = 'loading' | 'setup' | 'locked' | 'unlocked' | 'unavailable';

/** Shown in `unavailable` (issue #371) — offering setup here would risk re-wrapping
 * the account's DEK, so the gate says why it cannot decide instead. */
const UNAVAILABLE_MESSAGE =
  'Ohne Verbindung lässt sich nicht prüfen, ob für dieses Konto schon eine Passphrase vergeben ist.';

/** Shown when a setup is attempted although an envelope already exists (issue #371). */
const ALREADY_SET_UP_MESSAGE =
  'Für dieses Konto gibt es bereits eine Passphrase. Entsperre das Journal, statt es neu einzurichten.';

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

  const local = await readEnvelope();
  if (current.state !== 'loading') return;
  if (local) {
    await settleWithEnvelope(ch);
    return;
  }

  // "No local envelope" is not "no envelope" (issue #371). A device that has never
  // pulled — fresh install, storage evicted by iOS, or simply the Safari container
  // next to the home-screen PWA — would otherwise be offered a setup, and that
  // setup upserts a new DEK onto the fixed row id, orphaning every existing entry.
  // So ask the server once before believing the local emptiness.
  const pulled = await pull();
  if (current.state !== 'loading') return;

  const remote = await readEnvelope();
  if (current.state !== 'loading') return;
  if (remote) {
    await settleWithEnvelope(ch);
    return;
  }

  if (!pulled) {
    setSnapshot({ state: 'unavailable', error: UNAVAILABLE_MESSAGE });
    return;
  }

  setSnapshot({ state: 'setup', error: null });
}

/** Locked, unless another tab is already unlocked and hands its DEK over (AC7). */
async function settleWithEnvelope(ch: BroadcastChannel): Promise<void> {
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

/** The way out of `unavailable` — same decision, run again (issue #371 AC4). */
export async function journalRetryInitialize(): Promise<void> {
  initPromise = null;
  setSnapshot({ state: 'loading', error: null });
  await ensureInitialized();
}

function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

/** Returns the recovery key (AC2, #372) — a KEK secret, never the DEK, shown to
 * the user exactly once and never sent to the server. `null` when setup is
 * refused because an envelope already exists (issue #371): the row id is fixed,
 * so a second setup would upsert a fresh DEK over the account's envelope and
 * leave every entry written under the old one permanently unreadable. */
export async function journalSetup(passphrase: string): Promise<string | null> {
  if (await readEnvelope()) {
    // Eine bereits entsperrte Sitzung bleibt entsperrt — der DEK im Speicher ist
    // gültig, nur das Einrichten wird verweigert.
    if (current.state !== 'unlocked') {
      setSnapshot({ state: 'locked', error: ALREADY_SET_UP_MESSAGE });
    }
    return null;
  }

  const result = await createEnvelopesWithRecovery(passphrase);
  await writeEnvelopes(result.passphraseEnvelope, result.recoveryEnvelope);
  dek = result.dek;
  setSnapshot({ state: 'unlocked', error: null });
  getChannel().postMessage({ type: 'unlocked', dek: result.dek } satisfies BroadcastMessage);
  armAutoLock();
  if (readJournalPersistPref()) await persistDek(result.dek);
  return result.recoveryKey;
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

/** Second unlock path via the recovery key (AC3). A missing recovery envelope
 * (e.g. a row from before #372) fails exactly like a wrong key — same message,
 * same state — so the UI cannot tell the two cases apart (AC5). */
export async function journalUnlockWithRecovery(recoveryKey: string): Promise<void> {
  const recoveryEnvelope = await readRecoveryEnvelope();
  if (!recoveryEnvelope) {
    setSnapshot({ state: 'locked', error: new WrongPassphraseError().message });
    return;
  }

  try {
    const opened = await openEnvelopeWithRecovery(recoveryEnvelope, recoveryKey);
    dek = opened;
    setSnapshot({ state: 'unlocked', error: null });
    getChannel().postMessage({ type: 'unlocked', dek: opened } satisfies BroadcastMessage);
    armAutoLock();
    if (readJournalPersistPref()) await persistDek(opened);
  } catch (error) {
    if (!(error instanceof WrongPassphraseError)) throw error;
    setSnapshot({ state: 'locked', error: error.message });
  }
}

/** Sets a new passphrase after a recovery unlock (AC4, optional) — the DEK
 * already in memory is untouched, so entries stay readable without a re-unlock;
 * only the passphrase envelope is rewrapped and pushed (`writeEnvelope`), never
 * the recovery envelope. */
export async function journalRewrapPassphrase(
  recoveryKey: string,
  newPassphrase: string,
): Promise<void> {
  const recoveryEnvelope = await readRecoveryEnvelope();
  if (!recoveryEnvelope) throw new WrongPassphraseError();
  const newEnvelope = await rewrapPassphrase(recoveryEnvelope, recoveryKey, newPassphrase);
  await writeEnvelope(newEnvelope);
}

/** Re-issues the recovery key (issue #391) — only while `unlocked` (AC "gesperrt
 * bietet keinen Zugang"); requires the passphrase since the DEK in memory is
 * non-extractable (ADR-0016) and the old recovery key is exactly what may be
 * lost. `null` on a wrong passphrase (ruhige Meldung, Regel 9), the new key is
 * shown to the user exactly once and never sent to the server. */
export async function journalReissueRecovery(passphrase: string): Promise<string | null> {
  if (current.state !== 'unlocked') return null;
  const envelope = await readEnvelope();
  if (!envelope) return null;

  try {
    const result = await reissueRecovery(envelope, passphrase);
    await writeRecoveryEnvelope(result.recoveryEnvelope);
    return result.recoveryKey;
  } catch (error) {
    if (!(error instanceof WrongPassphraseError)) throw error;
    return null;
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

/** The unpacked DEK for callers that need to en-/decrypt an entry (S3b, #340) —
 * still never touches React state or the server, only the in-memory module
 * variable above. `null` whenever the journal is not `unlocked`. */
export function journalDek(): CryptoKey | null {
  return dek;
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
    unlockWithRecovery: journalUnlockWithRecovery,
    rewrapPassphrase: journalRewrapPassphrase,
    reissueRecovery: journalReissueRecovery,
    lock: journalLock,
    retry: journalRetryInitialize,
  };
}
