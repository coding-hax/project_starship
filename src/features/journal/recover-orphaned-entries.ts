import { base64ToBytes, bytesToBase64 } from '@/crypto/base64';
import { WrongPassphraseError } from '@/crypto/errors';
import {
  decryptJournal,
  encryptJournal,
  journalEntryAad,
  openEnvelope,
  openEnvelopeWithRecovery,
  type Envelope,
} from '@/crypto/journal';
import { db } from '@/local/dexie';
import { mutate } from '@/local/outbox';
import { deleteJournalKeyStash, listJournalKeyStash } from './journal-key-stash';
import { journalDek } from './lock-store';

/**
 * Recovers entries a displaced `journal_keys` envelope (issue #518) left
 * unreadable: opens every stashed envelope with `secret` (the passphrase or
 * recovery key that was valid *back when it was displaced*), and for every live
 * `journal_entries` row that the current DEK cannot decrypt but the stashed one
 * can, re-encrypts it under the current DEK and writes it back through the normal
 * outbox (same row id — a plain content update, not a new row).
 *
 * Returns the number of entries recovered. `0` covers both "wrong secret" and
 * "nothing to recover" indistinguishably on purpose (Regel 9, same as
 * `journalUnlock`'s uniform `WrongPassphraseError` message) — the caller shows one
 * calm message either way, never one that would let a guess be narrowed down.
 */
export async function recoverOrphanedEntries(
  secret: string,
  useRecoveryKey: boolean,
): Promise<number> {
  const currentDek = journalDek();
  if (!currentDek) return 0;

  const stash = await listJournalKeyStash();
  if (stash.length === 0) return 0;

  const rows = await db.records
    .where('table')
    .equals('journal_entries')
    .and((row) => row.deletedAt === null)
    .toArray();

  let recovered = 0;

  for (const stashed of stash) {
    let dekAlt: CryptoKey;
    try {
      // `stashed.envelope` is the passphrase wrap, `stashed.recoveryEnvelope` the
      // separate recovery-key wrap (issue #372) — the two are wrapped under
      // different KEKs around the same DEK. Opening the wrong one for the mode
      // the caller picked isn't "wrong secret", it's certain failure regardless
      // of the secret's own correctness, so a missing `recoveryEnvelope` (a
      // stash captured before #372, or a device that never had one) is folded
      // into the same WrongPassphraseError path as an actual wrong key (Regel 9).
      if (useRecoveryKey) {
        if (!stashed.recoveryEnvelope) throw new WrongPassphraseError();
        dekAlt = await openEnvelopeWithRecovery(stashed.recoveryEnvelope as Envelope, secret);
      } else {
        dekAlt = await openEnvelope(stashed.envelope as Envelope, secret);
      }
    } catch (error) {
      if (!(error instanceof WrongPassphraseError)) throw error;
      continue; // Not the right secret for this stash entry — try the next one, if any.
    }

    for (const row of rows) {
      const ciphertext = base64ToBytes(row.data.ciphertext as string);
      const nonce = base64ToBytes(row.data.nonce as string);
      const aad = journalEntryAad(row.id, row.data.entryDate as string);

      try {
        await decryptJournal(currentDek, ciphertext, nonce, aad);
        continue; // Already readable under the current DEK — not an orphan.
      } catch {
        // Falls through to the recovery attempt below.
      }

      let content;
      try {
        content = await decryptJournal(dekAlt, ciphertext, nonce, aad);
      } catch {
        continue; // Undecryptable under this DEK too (issue #384) — not this stash's row.
      }

      const reEncrypted = await encryptJournal(currentDek, content, aad);
      await mutate({
        table: 'journal_entries',
        rowId: row.id,
        op: 'upsert',
        payload: {
          ciphertext: bytesToBase64(reEncrypted.ciphertext),
          nonce: bytesToBase64(reEncrypted.nonce),
        },
      });
      recovered++;
    }

    // This stash entry served its purpose (recovered or not — a right secret with
    // zero orphans means every entry it once protected is readable some other way
    // already) — nothing recovers twice from the same envelope.
    await deleteJournalKeyStash(stashed.id);
  }

  return recovered;
}
