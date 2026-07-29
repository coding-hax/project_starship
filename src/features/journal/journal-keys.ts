import type { Envelope } from '@/crypto/envelope';
import { db } from '@/local/dexie';
import { mutate } from '@/local/outbox';

/**
 * Fixed, checked-in row id (ADR-0016) — one envelope per account, no per-device
 * recovery key yet (that is S6/#343). Two devices racing a first setup converge
 * via the normal ADR-0008 arrival-wins conflict, same as any other row.
 */
export const JOURNAL_KEYS_ROW_ID = '3f2a9b6e-9d3c-4f7a-8b2e-6b1c9a4d7e05';

export async function readEnvelope(): Promise<Envelope | null> {
  const row = await db.records.get(['journal_keys', JOURNAL_KEYS_ROW_ID] as never);
  if (!row || row.deletedAt !== null) return null;
  return (row.data.envelope as Envelope | undefined) ?? null;
}

export async function writeEnvelope(envelope: Envelope): Promise<void> {
  await mutate({
    table: 'journal_keys',
    rowId: JOURNAL_KEYS_ROW_ID,
    op: 'upsert',
    payload: { envelope },
  });
}
