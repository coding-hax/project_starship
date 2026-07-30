'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal } from '@/crypto/journal';
import { db } from '@/local/dexie';
import { todayKey } from './entry';
import { logJournalQueryError } from './log-query-error';
import { journalDek, useJournalLock } from './lock-store';

export interface JournalTodayState {
  written: boolean;
  /** Only ever set while unlocked (issue #342 AC4) — `null` covers both "locked"
   * and "no mood recorded today" on purpose, since both fall back to the same
   * binary display (AC2). Since issue #376 a day can carry several entries;
   * this is the most recent one's mood. */
  mood: string | null;
}

interface RowData {
  ciphertext: string;
  nonce: string;
  createdAt?: string;
}

/**
 * "Written today?" for the overview (issue #342): at least one entry answers
 * AC1/AC2 without a key, since `entryDate` is the only plaintext (ADR-0004) —
 * the live query below never touches the DEK. Since issue #376 AC7, "written"
 * means at least one entry, not exactly one. Mood (AC4) is the richer half and
 * needs it; `useJournalLock()` only serves as a re-render trigger here (its
 * `state` itself is unused) so `journalDek()` is read fresh on every lock/unlock,
 * which is what keeps a stale mood from a previous unlock leaking into the
 * locked, binary view.
 */
export function useJournalToday(): JournalTodayState | undefined {
  const [entryDate] = useState(todayKey);
  useJournalLock();
  const [rows, setRows] = useState<RowData[] | undefined>(undefined);
  const [decrypted, setDecrypted] = useState<{ rows: RowData[]; mood: string | null } | null>(null);

  useEffect(() => {
    const subscription = liveQuery(async () => {
      const records = await db.records.where('table').equals('journal_entries').toArray();
      return records
        .filter((record) => record.deletedAt === null && record.data.entryDate === entryDate)
        .map((record) => record.data as unknown as RowData);
    }).subscribe({
      next: setRows,
      error: () => logJournalQueryError('journal today live query failed'),
    });
    return () => subscription.unsubscribe();
  }, [entryDate]);

  const dek = journalDek();

  useEffect(() => {
    if (!rows || rows.length === 0 || !dek) return;
    const latest = [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]!;
    let cancelled = false;
    void decryptJournal(dek, base64ToBytes(latest.ciphertext), base64ToBytes(latest.nonce)).then(
      (content) => {
        if (!cancelled) setDecrypted({ rows, mood: content.mood ?? null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rows, dek]);

  if (rows === undefined) return undefined;
  const mood = dek && decrypted?.rows === rows ? decrypted.mood : null;
  return { written: rows.length > 0, mood };
}
