import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '@/crypto/base64';
import { WrongPassphraseError } from '@/crypto/errors';
import type { LocalRecord } from '@/local/dexie';

const decryptJournal = vi.fn();
const encryptJournal = vi.fn();
const journalEntryAad = vi.fn();
const openEnvelope = vi.fn();
const openEnvelopeWithRecovery = vi.fn();
vi.mock('@/crypto/journal', () => ({
  decryptJournal: (...args: unknown[]) => decryptJournal(...args),
  encryptJournal: (...args: unknown[]) => encryptJournal(...args),
  journalEntryAad: (...args: unknown[]) => journalEntryAad(...args),
  openEnvelope: (...args: unknown[]) => openEnvelope(...args),
  openEnvelopeWithRecovery: (...args: unknown[]) => openEnvelopeWithRecovery(...args),
}));

const recordsRows = vi.fn();
vi.mock('@/local/dexie', () => ({
  db: {
    records: {
      where: () => ({
        equals: () => ({
          and: (predicate: (row: LocalRecord) => boolean) => ({
            toArray: async () => recordsRows().filter(predicate),
          }),
        }),
      }),
    },
  },
}));

const mutate = vi.fn();
vi.mock('@/local/outbox', () => ({ mutate: (...args: unknown[]) => mutate(...args) }));

const listJournalKeyStash = vi.fn();
const deleteJournalKeyStash = vi.fn();
vi.mock('./journal-key-stash', async () => {
  // `sameJson` stays real (issue #1143 relies on its order-independent jsonb
  // compare exactly as `stashDisplacedJournalKey` does) — only list/delete are
  // test doubles.
  const actual = await vi.importActual<typeof import('./journal-key-stash')>('./journal-key-stash');
  return {
    ...actual,
    listJournalKeyStash: (...args: unknown[]) => listJournalKeyStash(...args),
    deleteJournalKeyStash: (...args: unknown[]) => deleteJournalKeyStash(...args),
  };
});

const readEnvelope = vi.fn();
vi.mock('./journal-keys', () => ({ readEnvelope: (...args: unknown[]) => readEnvelope(...args) }));

const journalDek = vi.fn();
const journalDekEnvelope = vi.fn();
vi.mock('./lock-store', () => ({
  journalDek: () => journalDek(),
  journalDekEnvelope: () => journalDekEnvelope(),
}));

import { recoverOrphanedEntries } from './recover-orphaned-entries';

/** Opaque sentinels — never real key material (Regel 9). */
const CURRENT_DEK = { name: 'current' } as unknown as CryptoKey;
const ALT_DEK = { name: 'alt' } as unknown as CryptoKey;

const ENV_B = { fake: 'envelope-B' };
const ENV_A = { fake: 'envelope-A' };
const ENV_C = { fake: 'envelope-C' };

function stashEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stash-1',
    envelope: ENV_A,
    recoveryEnvelope: undefined,
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function entryRow(id: string): LocalRecord {
  return {
    table: 'journal_entries',
    id,
    updatedAt: '2026-08-01T00:00:00.000Z',
    deletedAt: null,
    syncedAt: null,
    syncSeq: 1,
    data: { entryDate: '2026-08-01', ciphertext: btoa('ct'), nonce: btoa('n') },
  };
}

/** Not readable under `CURRENT_DEK`, readable under `ALT_DEK` — the shape of an
 * orphan the displaced envelope's stash can still recover. */
function makeOrphanDecrypt() {
  return async (dek: CryptoKey) => {
    if (dek === CURRENT_DEK) throw new Error('not readable under current');
    if (dek === ALT_DEK) return { text: 'geheim', tags: [] };
    throw new Error('unexpected dek');
  };
}

beforeEach(() => {
  decryptJournal.mockReset();
  encryptJournal.mockReset();
  journalEntryAad.mockReset().mockReturnValue(new Uint8Array());
  openEnvelope.mockReset();
  openEnvelopeWithRecovery.mockReset();
  recordsRows.mockReset().mockReturnValue([entryRow('row-1')]);
  mutate.mockReset().mockResolvedValue(undefined);
  listJournalKeyStash.mockReset().mockResolvedValue([stashEntry()]);
  deleteJournalKeyStash.mockReset().mockResolvedValue(undefined);
  readEnvelope.mockReset().mockResolvedValue(ENV_B);
  journalDek.mockReset().mockReturnValue(CURRENT_DEK);
  journalDekEnvelope.mockReset().mockReturnValue(ENV_B);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('recoverOrphanedEntries (issue #1143)', () => {
  it('AC3 — Herkunft des DEK stammt nicht aus dem aktuell gültigen Envelope: No-Op', async () => {
    journalDekEnvelope.mockReturnValue(ENV_A); // the DEK in memory is still the displaced one.
    readEnvelope.mockResolvedValue(ENV_B);

    const recovered = await recoverOrphanedEntries('secret', false);

    expect(recovered).toBe(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(deleteJournalKeyStash).not.toHaveBeenCalled();
  });

  it('AC3 — unbekannte Herkunft (null) wird wie veraltet behandelt: No-Op', async () => {
    journalDekEnvelope.mockReturnValue(null); // e.g. a persisted DEK, never re-unlocked in this tab.

    const recovered = await recoverOrphanedEntries('secret', false);

    expect(recovered).toBe(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(deleteJournalKeyStash).not.toHaveBeenCalled();
  });

  it('AC4 — Herkunft passt zum aktuellen Envelope: ein sonst unlesbarer Eintrag wird unter dem aktuellen DEK neu verschlüsselt', async () => {
    openEnvelope.mockResolvedValue(ALT_DEK);
    decryptJournal.mockImplementation(makeOrphanDecrypt());
    encryptJournal.mockResolvedValue({ ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]) });

    const recovered = await recoverOrphanedEntries('secret', false);

    expect(recovered).toBe(1);
    expect(mutate).toHaveBeenCalledWith({
      table: 'journal_entries',
      rowId: 'row-1',
      op: 'upsert',
      payload: {
        ciphertext: bytesToBase64(new Uint8Array([1])),
        nonce: bytesToBase64(new Uint8Array([2])),
      },
    });
    expect(deleteJournalKeyStash).toHaveBeenCalledWith('stash-1');
  });

  it('AC5 — falsches Geheimnis: WrongPassphraseError bleibt 0, keine Mutation, kein Delete', async () => {
    openEnvelope.mockRejectedValue(new WrongPassphraseError());

    const recovered = await recoverOrphanedEntries('falsch', false);

    expect(recovered).toBe(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(deleteJournalKeyStash).not.toHaveBeenCalled();
  });

  it('AC5 — abgebrochene Mutation: die Funktion rejectet, der Stash bleibt erhalten', async () => {
    openEnvelope.mockResolvedValue(ALT_DEK);
    decryptJournal.mockImplementation(makeOrphanDecrypt());
    encryptJournal.mockResolvedValue({ ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]) });
    mutate.mockRejectedValue(new Error('outbox kaputt'));

    await expect(recoverOrphanedEntries('secret', false)).rejects.toThrow('outbox kaputt');
    expect(deleteJournalKeyStash).not.toHaveBeenCalled();
  });

  it('AC5 — Envelope-Wechsel während der Bergung: die erneute Prüfung vor dem Delete verweigert ihn', async () => {
    openEnvelope.mockResolvedValue(ALT_DEK);
    decryptJournal.mockImplementation(makeOrphanDecrypt());
    encryptJournal.mockResolvedValue({ ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]) });
    // Gate check sees B (current); the re-check right before the delete sees a
    // third envelope C — another pull landed mid-recovery.
    readEnvelope.mockResolvedValueOnce(ENV_B).mockResolvedValueOnce(ENV_C);

    const recovered = await recoverOrphanedEntries('secret', false);

    expect(recovered).toBe(1); // the row itself is still recovered...
    expect(mutate).toHaveBeenCalled();
    expect(deleteJournalKeyStash).not.toHaveBeenCalled(); // ...but the stash survives for a later run.
  });
});
