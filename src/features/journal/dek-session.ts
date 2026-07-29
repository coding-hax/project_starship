import { db } from '@/local/dexie';

const DEK_ROW_ID = 'dek';

/**
 * The one row in `journalSession` (opt-in only, issue #339 AC5). `dek` is stored
 * non-extractable — IndexedDB clones the `CryptoKey` handle, never the raw bytes.
 */
export async function persistDek(dek: CryptoKey): Promise<void> {
  await db.journalSession.put({ id: DEK_ROW_ID, dek });
}

export async function getPersistedDek(): Promise<CryptoKey | null> {
  const row = await db.journalSession.get(DEK_ROW_ID);
  return row?.dek ?? null;
}

export async function clearPersistedDek(): Promise<void> {
  await db.journalSession.delete(DEK_ROW_ID);
}
