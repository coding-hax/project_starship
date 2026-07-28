'use client';

import { useEffect } from 'react';
import { bytesToBase64 } from '@/crypto/base64';
import { writeJournalEntry } from '@/features/journal/write';
import { db } from '@/local/dexie';
import { mutate, pending, size } from '@/local/outbox';
import { startSync, sync } from '@/local/sync';
import { journalEntryId } from '@/local/uuid5';
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
        // The real write path (AC5) plus the real conflict-copy store (AC6) — the
        // suite drives writeJournalEntry itself rather than re-deriving row ids in
        // the test, and reads what pull() actually stashed instead of duplicating
        // its logic.
        journalEntryId,
        writeJournalEntry: (entryDate: string, ciphertext: number[], nonce: number[]) =>
          writeJournalEntry(entryDate, {
            ciphertext: new Uint8Array(ciphertext),
            nonce: new Uint8Array(nonce),
          }),
        bytesToBase64: (bytes: number[]) => bytesToBase64(new Uint8Array(bytes)),
        debugJournalConflicts: () => db.journalConflicts.toArray(),
        // Wire-format corruption (a bad payload from an old client build, storage
        // damage) is not something `mutate()` can produce itself — this is the only
        // way to reproduce a poison mutation for the #182 tests.
        debugPatchOutbox: (id: string, patch: Record<string, unknown>) =>
          db.outbox.update(id, patch),
      },
    });
  }, []);

  return null;
}
