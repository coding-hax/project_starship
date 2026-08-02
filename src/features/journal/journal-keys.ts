import type { Envelope } from '@/crypto/envelope';
import { db } from '@/local/dexie';
import { mutate } from '@/local/outbox';

/**
 * Fixed, checked-in row id (ADR-0016) — one envelope per account, plus the
 * recovery wrap from #343 (S6). Two devices racing a first setup converge via
 * the normal ADR-0008 arrival-wins conflict, same as any other row.
 */
export const JOURNAL_KEYS_ROW_ID = '3f2a9b6e-9d3c-4f7a-8b2e-6b1c9a4d7e05';

/**
 * The one row whose tombstone is deliberately ignored (issue #453).
 *
 * Everywhere else a soft-deleted row means "gone". For the row holding the
 * account's key material that reading is unsafe: "no envelope" sends the gate to
 * `setup`, and a setup mints a *new* DEK onto this fixed row id — orphaning every
 * entry written under the old one. A deleted key row that still carries a wrap
 * means the journal is locked, not un-set-up.
 *
 * It was not a theoretical hole. A tombstone on this row (observed in production
 * on 02.08.26, the only deleted row in the whole database) made the gate offer a
 * fresh setup on *every* cold start, and `resolveDeletedAt` keeps an existing
 * `deletedAt` for `upsert` (src/local/conflict.ts) — so each new passphrase was
 * written straight back into the grave, the next pull returned a deleted row
 * again, and the loop cost another set of entries every time round.
 */
async function readKeyRow() {
  return db.records.get(['journal_keys', JOURNAL_KEYS_ROW_ID] as never);
}

export async function readEnvelope(): Promise<Envelope | null> {
  const row = await readKeyRow();
  if (!row) return null;
  return (row.data.envelope as Envelope | undefined) ?? null;
}

export async function readRecoveryEnvelope(): Promise<Envelope | null> {
  const row = await readKeyRow();
  if (!row) return null;
  return (row.data.recoveryEnvelope as Envelope | undefined) ?? null;
}

/** True while the key row carries a tombstone — the state `restoreKeyRow` heals. */
export async function keyRowIsTombstoned(): Promise<boolean> {
  const row = await readKeyRow();
  return row != null && row.deletedAt !== null;
}

/**
 * Clears the tombstone without touching either wrap, so the account converges back
 * to a live key row (issue #453). Payload-free on purpose: `writableFields` maps an
 * empty payload to no columns, leaving both wraps exactly as they are.
 */
export async function restoreKeyRow(): Promise<void> {
  await mutate({ table: 'journal_keys', rowId: JOURNAL_KEYS_ROW_ID, op: 'restore' });
}

/**
 * First-time setup: writes both KEK wraps in one mutation.
 *
 * `restore`, not `upsert` (issue #453) — writing key material must also heal a
 * tombstone on the row. `resolveDeletedAt` returns the *existing* `deletedAt` for
 * an `upsert`, so an upsert here would write a fresh wrap into a deleted row and
 * the next pull would hand it straight back as "no envelope". On a live row the
 * two ops are identical: `deletedAt` is already null.
 */
export async function writeEnvelopes(
  envelope: Envelope,
  recoveryEnvelope: Envelope,
): Promise<void> {
  await mutate({
    table: 'journal_keys',
    rowId: JOURNAL_KEYS_ROW_ID,
    op: 'restore',
    payload: { envelope, recoveryEnvelope },
  });
}

/**
 * Rewrap only — pushes just `envelope`, so the merge on both the client
 * (`outbox.ts`) and server (`push/route.ts`) leaves `recoveryEnvelope` untouched.
 * `restore` for the same reason as `writeEnvelopes` above.
 */
export async function writeEnvelope(envelope: Envelope): Promise<void> {
  await mutate({
    table: 'journal_keys',
    rowId: JOURNAL_KEYS_ROW_ID,
    op: 'restore',
    payload: { envelope },
  });
}

/**
 * Reissue only (issue #391) — mirrors `writeEnvelope`: pushes just
 * `recoveryEnvelope`, so the merge on both the client (`outbox.ts`) and server
 * (`push/route.ts`) leaves `envelope` untouched.
 */
export async function writeRecoveryEnvelope(recoveryEnvelope: Envelope): Promise<void> {
  await mutate({
    table: 'journal_keys',
    rowId: JOURNAL_KEYS_ROW_ID,
    op: 'restore',
    payload: { recoveryEnvelope },
  });
}
