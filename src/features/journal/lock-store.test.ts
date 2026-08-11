import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Kanalname aus lock-store.ts (`BROADCAST_CHANNEL_NAME`, nicht exportiert).
const NAME = 'starship:journal-lock';

const pull = vi.fn();
const syncFn = vi.fn();
vi.mock('@/local/sync', () => ({ pull, sync: syncFn }));

const getPersistedDek = vi.fn();
const persistDek = vi.fn();
const clearPersistedDek = vi.fn();
vi.mock('./dek-session', () => ({ getPersistedDek, persistDek, clearPersistedDek }));

const readEnvelope = vi.fn();
const readRecoveryEnvelope = vi.fn();
const writeEnvelope = vi.fn();
const writeEnvelopes = vi.fn();
const writeRecoveryEnvelope = vi.fn();
const keyRowIsTombstoned = vi.fn();
const restoreKeyRow = vi.fn();
vi.mock('./journal-keys', () => ({
  readEnvelope,
  readRecoveryEnvelope,
  writeEnvelope,
  writeEnvelopes,
  writeRecoveryEnvelope,
  keyRowIsTombstoned,
  restoreKeyRow,
}));

const readJournalPersistPref = vi.fn();
const subscribeJournalPersistPref = vi.fn();
vi.mock('./use-journal-persist-pref', () => ({
  readJournalPersistPref,
  subscribeJournalPersistPref,
}));

const openEnvelope = vi.fn();
vi.mock('@/crypto/envelope', () => ({ openEnvelope }));

const createEnvelopesWithRecovery = vi.fn();
const openEnvelopeWithRecovery = vi.fn();
const reissueRecovery = vi.fn();
const rewrapPassphrase = vi.fn();
vi.mock('@/crypto/journal', () => ({
  createEnvelopesWithRecovery,
  openEnvelopeWithRecovery,
  reissueRecovery,
  rewrapPassphrase,
}));

/** Opaque sentinel — never real key material (Regel 9). */
const fakeDek = { type: 'secret' } as unknown as CryptoKey;

interface FakeMessageEvent {
  data: unknown;
}

/** Minimal same-process `BroadcastChannel` stub — a static registry per channel
 * name delivers synchronously to every *other* instance, mirroring the real
 * same-tab-excluded semantics the store depends on. */
class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();

  static reset() {
    FakeBroadcastChannel.registry.clear();
  }

  name: string;
  onmessage: ((event: FakeMessageEvent) => void) | null = null;
  private listeners = new Set<(event: FakeMessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    if (!FakeBroadcastChannel.registry.has(name)) {
      FakeBroadcastChannel.registry.set(name, new Set());
    }
    FakeBroadcastChannel.registry.get(name)?.add(this);
  }

  postMessage(data: unknown) {
    const peers = FakeBroadcastChannel.registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue;
      const event: FakeMessageEvent = { data };
      peer.onmessage?.(event);
      for (const listener of peer.listeners) listener(event);
    }
  }

  addEventListener(type: string, listener: (event: FakeMessageEvent) => void) {
    if (type !== 'message') return;
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: FakeMessageEvent) => void) {
    if (type !== 'message') return;
    this.listeners.delete(listener);
  }

  close() {
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

/** Minimal `document` stub — only the two listener methods `armAutoLock`/
 * `disarmAutoLock` touch, keyed by event type so `removeEventListener` finds the
 * same function identity `addEventListener` stored. */
const fakeDocument = {
  listenersByType: new Map<string, Set<() => void>>(),
  addEventListener(type: string, listener: () => void) {
    if (!fakeDocument.listenersByType.has(type)) fakeDocument.listenersByType.set(type, new Set());
    fakeDocument.listenersByType.get(type)?.add(listener);
  },
  removeEventListener(type: string, listener: () => void) {
    fakeDocument.listenersByType.get(type)?.delete(listener);
  },
  reset() {
    fakeDocument.listenersByType.clear();
  },
};

function fireDocumentEvent(type: string) {
  for (const listener of fakeDocument.listenersByType.get(type) ?? []) listener();
}

describe('lock-store', () => {
  let store: typeof import('./lock-store');

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    pull.mockReset().mockResolvedValue(false);
    syncFn.mockReset().mockResolvedValue(undefined);
    getPersistedDek.mockReset().mockResolvedValue(null);
    persistDek.mockReset().mockResolvedValue(undefined);
    clearPersistedDek.mockReset().mockResolvedValue(undefined);
    readEnvelope.mockReset().mockResolvedValue({ fake: 'envelope' });
    readRecoveryEnvelope.mockReset().mockResolvedValue(null);
    writeEnvelope.mockReset().mockResolvedValue(undefined);
    writeEnvelopes.mockReset().mockResolvedValue(undefined);
    writeRecoveryEnvelope.mockReset().mockResolvedValue(undefined);
    keyRowIsTombstoned.mockReset().mockResolvedValue(false);
    restoreKeyRow.mockReset().mockResolvedValue(undefined);
    readJournalPersistPref.mockReset().mockReturnValue(false);
    subscribeJournalPersistPref.mockReset().mockReturnValue(() => {});
    openEnvelope.mockReset().mockResolvedValue(fakeDek);
    createEnvelopesWithRecovery.mockReset();
    openEnvelopeWithRecovery.mockReset();
    reissueRecovery.mockReset();
    rewrapPassphrase.mockReset();

    FakeBroadcastChannel.reset();
    fakeDocument.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('document', fakeDocument);

    store = await import('./lock-store');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Deterministically reaches `unlocked` without going through `initialize()`/
   * `pull()` — the simplest path for AC1-5, which don't touch bootstrap. */
  async function reachUnlocked() {
    await store.journalUnlock('correct horse battery staple');
  }

  describe('AK1 — Auto-Lock + Fristverlängerung', () => {
    it('schnappt nach AUTO_LOCK_MS Inaktivität zu', async () => {
      await reachUnlocked();
      expect(store.journalLockSnapshot().state).toBe('unlocked');

      await vi.advanceTimersByTimeAsync(store.AUTO_LOCK_MS - 1);
      expect(store.journalLockSnapshot().state).toBe('unlocked');

      await vi.advanceTimersByTimeAsync(1);
      expect(store.journalLockSnapshot().state).toBe('locked');
      expect(store.journalDek()).toBeNull();
    });

    it('Aktivität vor Ablauf setzt die Frist zurück', async () => {
      await reachUnlocked();

      await vi.advanceTimersByTimeAsync(store.AUTO_LOCK_MS / 2);
      fireDocumentEvent('pointerdown');

      await vi.advanceTimersByTimeAsync(store.AUTO_LOCK_MS / 2);
      expect(store.journalLockSnapshot().state).toBe('unlocked');

      await vi.advanceTimersByTimeAsync(store.AUTO_LOCK_MS / 2);
      expect(store.journalLockSnapshot().state).toBe('locked');
    });
  });

  describe('AK2 — Tab-übergreifend', () => {
    it('adoptiert ein Unlock, das ein anderer Tab meldet', async () => {
      await store.journalLock();
      expect(store.journalLockSnapshot().state).toBe('locked');

      const otherTab = new FakeBroadcastChannel(NAME);
      otherTab.postMessage({ type: 'unlocked', dek: fakeDek });

      expect(store.journalDek()).toBe(fakeDek);
      expect(store.journalLockSnapshot().state).toBe('unlocked');
    });

    it('meldet sein eigenes Unlock an andere Tabs', async () => {
      const otherTab = new FakeBroadcastChannel(NAME);
      const received: unknown[] = [];
      otherTab.onmessage = (event) => received.push(event.data);

      await reachUnlocked();

      expect(received).toEqual([{ type: 'unlocked', dek: fakeDek }]);
    });

    it('folgt einem Lock, das ein anderer Tab meldet', async () => {
      await reachUnlocked();

      const otherTab = new FakeBroadcastChannel(NAME);
      otherTab.postMessage({ type: 'locked' });

      expect(store.journalLockSnapshot().state).toBe('locked');
      expect(store.journalDek()).toBeNull();
    });

    it('meldet sein eigenes Lock an andere Tabs', async () => {
      await reachUnlocked();

      const otherTab = new FakeBroadcastChannel(NAME);
      const received: unknown[] = [];
      otherTab.onmessage = (event) => received.push(event.data);

      await store.journalLock();

      expect(received).toEqual([{ type: 'locked' }]);
    });
  });

  describe('AK3 — DEK nach Sperren unerreichbar', () => {
    it('journalLock löscht den DEK aus dem Zustand', async () => {
      await reachUnlocked();
      expect(store.journalDek()).toBe(fakeDek);

      await store.journalLock();

      expect(store.journalDek()).toBeNull();
      expect(store.journalLockSnapshot().state).toBe('locked');
      expect(clearPersistedDek).toHaveBeenCalled();
      expect(Object.keys(store.journalLockSnapshot())).toEqual(['state', 'error']);
    });
  });

  describe('AK4 — Ereignis nach dem Sperren entsperrt nicht versehentlich', () => {
    it('Aktivität nach dem Sperren löst kein erneutes Entsperren aus', async () => {
      await reachUnlocked();
      await store.journalLock();

      fireDocumentEvent('pointerdown');
      await vi.advanceTimersByTimeAsync(store.AUTO_LOCK_MS);

      expect(store.journalLockSnapshot().state).toBe('locked');
    });

    it('eine request-Nachricht nach dem Sperren bekommt keine Antwort', async () => {
      await reachUnlocked();
      await store.journalLock();

      const otherTab = new FakeBroadcastChannel(NAME);
      const received: unknown[] = [];
      otherTab.onmessage = (event) => received.push(event.data);

      otherTab.postMessage({ type: 'request' });

      expect(received).toEqual([]);
      expect(store.journalLockSnapshot().state).toBe('locked');
    });
  });

  describe('AK5 — kein Klartext/Schlüsselmaterial in Ausgaben (Regel 9)', () => {
    it('der öffentliche Snapshot exponiert nur state und error', async () => {
      await reachUnlocked();

      const snapshot = store.journalLockSnapshot();
      expect(Object.keys(snapshot)).toEqual(['state', 'error']);
      expect(JSON.stringify(snapshot)).not.toMatch(/dek/i);
    });
  });
});
