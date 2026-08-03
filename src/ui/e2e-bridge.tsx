'use client';

import { useEffect } from 'react';
import { bytesToBase64 } from '@/crypto/base64';
import { createEnvelope, openEnvelope, type Envelope, type KdfParams } from '@/crypto/envelope';
import { encryptJournal, type JournalContent } from '@/crypto/journal';
import { getPersistedDek } from '@/features/journal/dek-session';
import { journalLock, journalLockSnapshot, journalSetup, journalUnlock } from '@/features/journal/lock-store';
import { appendJournalEntry, deleteJournalEntry, listJournalEntries } from '@/features/journal/entry';
import { writeJournalEntry } from '@/features/journal/write';
import { db } from '@/local/dexie';
import { mutate, pending, size } from '@/local/outbox';
import { startSync, sync } from '@/local/sync';
import { getStoragePersistenceStatus } from './persist-storage';

/**
 * A handle on the real outbox for the E2E suite.
 *
 * M0 has no feature UI yet, so there is nothing that can write a mutation — but the
 * acceptance criterion ("outbox takes a mutation, survives a reload, reaches Postgres")
 * has to be tested against the real thing, not a mock. This exposes the actual
 * outbox and sync functions, the same ones the tasks UI will call in M1.
 *
 * Only rendered when NEXT_PUBLIC_E2E=1, which is set by the Playwright web server
 * and by nothing else. It is not in the production bundle.
 */
export function E2EBridge() {
  useEffect(() => {
    Object.assign(window, {
      __starship: {
        mutate,
        sync,
        pending,
        size,
        startSync,
        persistStatus: getStoragePersistenceStatus,
        debugRecords: () => db.records.toArray(),
        debugMeta: () => db.meta.toArray(),
        // Every JSON-serializable store in one string (issue #341 AC2) — the search
        // session cache lives only in React state, so a plaintext leak into any
        // store, not just `records`, would show up here as a substring match.
        // `journalSession` holds a CryptoKey, not text, and is left out on purpose.
        debugDumpStores: async () => {
          const [outbox, records, meta, weather] = await Promise.all([
            db.outbox.toArray(),
            db.records.toArray(),
            db.meta.toArray(),
            db.weather.toArray(),
          ]);
          return JSON.stringify({ outbox, records, meta, weather });
        },
        // The real write path (AC5) — the suite drives writeJournalEntry itself
        // rather than re-deriving row ids in the test. createEnvelope/openEnvelope/
        // encryptJournal let AC7 prove the offline row that reaches Postgres is
        // real ciphertext, not a stand-in — the CryptoKey a call returns only ever
        // travels to the next call inside the same page.evaluate, never back
        // across the Node/browser boundary.
        writeJournalEntry: (entryDate: string, ciphertext: number[], nonce: number[]) =>
          writeJournalEntry(entryDate, {
            ciphertext: new Uint8Array(ciphertext),
            nonce: new Uint8Array(nonce),
          }),
        // Seeds a real, decryptable entry for a given day under the actual unlocked
        // session's DEK — the same call the editor itself makes (issue #341's
        // search suite needs several days of real content, not raw filler bytes).
        appendJournalEntry: (entryDate: string, content: JournalContent) =>
          appendJournalEntry(entryDate, content),
        listJournalEntries: (entryDate: string) => listJournalEntries(entryDate),
        deleteJournalEntry: (id: string) => deleteJournalEntry(id),
        bytesToBase64: (bytes: number[]) => bytesToBase64(new Uint8Array(bytes)),
        createEnvelope: (passphrase: string, kdfParamsOverride?: Omit<KdfParams, 'salt'>) =>
          createEnvelope(passphrase, kdfParamsOverride),
        openEnvelope: (envelope: Envelope, passphrase: string) => openEnvelope(envelope, passphrase),
        encryptJournal: async (dek: CryptoKey, content: JournalContent) => {
          const { ciphertext, nonce } = await encryptJournal(dek, content);
          return { ciphertext: Array.from(ciphertext), nonce: Array.from(nonce) };
        },
        // Wire-format corruption (a bad payload from an old client build, storage
        // damage) is not something `mutate()` can produce itself — this is the only
        // way to reproduce a poison mutation for the #182 tests.
        debugPatchOutbox: (id: string, patch: Record<string, unknown>) =>
          db.outbox.update(id, patch),
        // Simulates a server-side ciphertext swap between two already-synced rows
        // (issue #480, F7 AC2) — something no client call can produce, only direct
        // storage tampering. `records` is keyed by `[table+id]`, not `id` alone.
        debugPatchRecord: (table: string, id: string, patch: Record<string, unknown>) =>
          db.records.update([table, id] as never, patch),
        // Drives the real lock-store state machine (issue #339) rather than a
        // test double — journalUnlock resolves 'ok'/'wrong' from the state it
        // actually landed in, never from the thrown error's message.
        journalSetup: (passphrase: string) => journalSetup(passphrase),
        journalUnlock: async (passphrase: string) => {
          await journalUnlock(passphrase);
          return journalLockSnapshot().state === 'unlocked' ? 'ok' : 'wrong';
        },
        journalLock: () => journalLock(),
        journalLockState: () => journalLockSnapshot().state,
        journalHasPersistedDek: () => getPersistedDek().then((dek) => dek !== null),
        // Proves AC5's "non-extractable" half: exportKey on the persisted DEK
        // must throw, never that it merely wasn't asked to export.
        journalPersistedDekExtractable: async () => {
          const key = await getPersistedDek();
          if (!key) return null;
          try {
            await crypto.subtle.exportKey('raw', key);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
  }, []);

  return null;
}
