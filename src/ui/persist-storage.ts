export type StoragePersistenceStatus = 'granted' | 'denied' | 'unsupported';

let cached: Promise<StoragePersistenceStatus> | null = null;
let lastStatus: StoragePersistenceStatus | null = null;

/** What the last `ensurePersistentStorage()` call resolved to — for a later UI ticket to read. */
export function getStoragePersistenceStatus(): StoragePersistenceStatus | null {
  return lastStatus;
}

/**
 * Asks the browser not to evict IndexedDB under storage pressure (issue #52). Safe to
 * call on every app start — the cached promise makes repeat calls within a session a
 * no-op, and `persisted()` is checked first so an already-granted origin is never
 * re-asked. Never throws: an unsupported API or a denial only warns, since local-first
 * degrades to "can be evicted", not "the app is broken".
 */
export function ensurePersistentStorage(): Promise<StoragePersistenceStatus> {
  if (!cached) {
    cached = requestPersistentStorage().then((status) => {
      lastStatus = status;
      return status;
    });
  }
  return cached;
}

async function requestPersistentStorage(): Promise<StoragePersistenceStatus> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage?.persist || !storage?.persisted) {
    console.warn(
      '[storage] persist() wird von diesem Browser nicht unterstützt — die Outbox kann bei Speicherdruck evictet werden.',
    );
    return 'unsupported';
  }

  try {
    if (await storage.persisted()) {
      return 'granted';
    }
    // Safari kann hier trotz korrektem Aufruf false liefern (Nutzer-Engagement /
    // installierte PWA vorausgesetzt) — das Anfragen bleibt trotzdem richtig und harmlos.
    const granted = await storage.persist();
    if (!granted) {
      console.warn(
        '[storage] persist() wurde verweigert — die Outbox kann bei Speicherdruck evictet werden.',
      );
    }
    return granted ? 'granted' : 'denied';
  } catch (error) {
    console.warn('[storage] persist()-Anfrage ist fehlgeschlagen', error);
    return 'unsupported';
  }
}
