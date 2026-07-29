'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal } from '@/crypto/journal';
import { db } from '@/local/dexie';
import { journalEntryId } from '@/local/uuid5';
import { todayKey } from './entry';
import { journalDek, useJournalLock } from './lock-store';

export interface JournalTodayState {
  written: boolean;
  /** Only ever set while unlocked (issue #342 AC4) — `null` covers both "locked"
   * and "no mood recorded today" on purpose, since both fall back to the same
   * binary display (AC2). */
  mood: string | null;
}

interface RowData {
  ciphertext: string;
  nonce: string;
}

/**
 * "Written today?" for the overview (issue #342): existence alone answers AC1/AC2
 * without a key, since `entryDate` is the only plaintext (ADR-0004) — the live
 * query below never touches the DEK. Mood (AC4) is the richer half and needs it;
 * `useJournalLock()` only serves as a re-render trigger here (its `state` itself
 * is unused) so `journalDek()` is read fresh on every lock/unlock, which is what
 * keeps a stale mood from a previous unlock leaking into the locked, binary view.
 */
export function useJournalToday(): JournalTodayState | undefined {
  const [entryDate] = useState(todayKey);
  useJournalLock();
  const [row, setRow] = useState<RowData | null | undefined>(undefined);
  const [decrypted, setDecrypted] = useState<{ row: RowData; mood: string | null } | null>(null);

  useEffect(() => {
    const subscription = liveQuery(async () => {
      const rowId = await journalEntryId(entryDate);
      const record = await db.records.get(['journal_entries', rowId] as never);
      return record && record.deletedAt === null ? (record.data as unknown as RowData) : null;
    }).subscribe({
      next: setRow,
      error: (error) => console.error('journal today live query failed', error),
    });
    return () => subscription.unsubscribe();
  }, [entryDate]);

  const dek = journalDek();

  useEffect(() => {
    if (!row || !dek) return;
    let cancelled = false;
    void decryptJournal(dek, base64ToBytes(row.ciphertext), base64ToBytes(row.nonce)).then(
      (content) => {
        if (!cancelled) setDecrypted({ row, mood: content.mood ?? null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [row, dek]);

  if (row === undefined) return undefined;
  const mood = dek && decrypted?.row === row ? decrypted.mood : null;
  return { written: row !== null, mood };
}
