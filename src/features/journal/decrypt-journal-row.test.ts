import { describe, expect, it } from 'vitest';
import { createEnvelope, openEnvelope } from '@/crypto/envelope';
import { encryptJournal, journalEntryAad } from '@/crypto/journal';
import { bytesToBase64 } from '@/crypto/base64';
import type { LocalRecord } from '@/local/dexie';
import { decryptJournalRows } from './decrypt-journal-row';

const FAST_KDF_PARAMS = { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 } as const;

async function makeDek(): Promise<CryptoKey> {
  const envelope = await createEnvelope('a test passphrase', FAST_KDF_PARAMS);
  return openEnvelope(envelope, 'a test passphrase');
}

function makeRow(id: string, ciphertext: string, nonce: string): LocalRecord {
  return {
    table: 'journal_entries',
    id,
    updatedAt: '2026-07-09T09:00:00.000Z',
    deletedAt: null,
    syncedAt: null,
    syncSeq: null,
    data: { entryDate: '2026-07-09', ciphertext, nonce },
  };
}

describe('decryptJournalRows', () => {
  it('issue #384: skips an undecryptable row instead of failing the whole batch', async () => {
    const dek = await makeDek();
    const { ciphertext, nonce } = await encryptJournal(dek, { text: 'lesbar', tags: [] });
    const rows = [
      makeRow('good', bytesToBase64(ciphertext), bytesToBase64(nonce)),
      makeRow('poison', 'bm90IGRlY3J5cHRhYmxl', 'MTIzNDU2Nzg5MDEy'),
    ];

    const entries = await decryptJournalRows(dek, rows, (row, content) => ({
      id: row.id,
      text: content.text,
    }));

    expect(entries).toEqual([{ id: 'good', text: 'lesbar' }]);
  });

  it('all rows decryptable: every row comes back, order preserved', async () => {
    const dek = await makeDek();
    const first = await encryptJournal(dek, { text: 'eins', tags: [] });
    const second = await encryptJournal(dek, { text: 'zwei', tags: [] });
    const rows = [
      makeRow('a', bytesToBase64(first.ciphertext), bytesToBase64(first.nonce)),
      makeRow('b', bytesToBase64(second.ciphertext), bytesToBase64(second.nonce)),
    ];

    const entries = await decryptJournalRows(dek, rows, (row, content) => ({
      id: row.id,
      text: content.text,
    }));

    expect(entries).toEqual([
      { id: 'a', text: 'eins' },
      { id: 'b', text: 'zwei' },
    ]);
  });

  it('issue #480 AC2: a v2 ciphertext swapped onto a foreign row (different id) drops out, the untouched row survives', async () => {
    const dek = await makeDek();
    const a = await encryptJournal(dek, { text: 'gehoert zu a', tags: [] }, journalEntryAad('a', '2026-07-09'));
    const rows = [
      // Own ciphertext on its own row (its own AAD) — control row, stays readable.
      makeRow('a', bytesToBase64(a.ciphertext), bytesToBase64(a.nonce)),
      // Same ciphertext/nonce placed under a foreign row id ("b") — AAD mismatch.
      makeRow('b', bytesToBase64(a.ciphertext), bytesToBase64(a.nonce)),
    ];

    const entries = await decryptJournalRows(dek, rows, (row, content) => ({
      id: row.id,
      text: content.text,
    }));

    expect(entries).toEqual([{ id: 'a', text: 'gehoert zu a' }]);
  });
});
