import { describe, expect, it } from 'vitest';
import { detectOverwrite, resolveDeletedAt, selectSince } from './conflict';

describe('resolveDeletedAt', () => {
  it('upsert never sets deleted_at — a fresh row stays alive', () => {
    expect(resolveDeletedAt('upsert', null, new Date('2026-07-17T10:00:00Z'))).toBeNull();
  });

  it('upsert never clears deleted_at either — tombstone-neutral', () => {
    const deletedAt = new Date('2026-07-17T09:00:00Z');
    expect(resolveDeletedAt('upsert', deletedAt, new Date('2026-07-17T10:00:00Z'))).toBe(
      deletedAt,
    );
  });

  it('delete sets deleted_at to the incoming timestamp, regardless of clock skew', () => {
    // A moved-back client clock must not change *whether* delete applies —
    // arrival order decides that, the timestamp is only ever stored for display.
    const skewedPast = new Date('1999-01-01T00:00:00Z');
    expect(resolveDeletedAt('delete', null, skewedPast)).toBe(skewedPast);
  });

  it('restore always clears deleted_at', () => {
    expect(resolveDeletedAt('restore', new Date('2026-07-17T09:00:00Z'), new Date())).toBeNull();
  });

  it('delete then update (both arrival orders) ends deleted — delete beats upsert', () => {
    // Order 1: update arrives, then delete.
    let deletedAt: Date | null = null;
    deletedAt = resolveDeletedAt('upsert', deletedAt, new Date('2026-07-17T10:00:00Z'));
    deletedAt = resolveDeletedAt('delete', deletedAt, new Date('2026-07-17T11:00:00Z'));
    expect(deletedAt).not.toBeNull();

    // Order 2: delete arrives first, then an update — tombstone-neutral upsert
    // must not resurrect it.
    let reversed: Date | null = null;
    reversed = resolveDeletedAt('delete', reversed, new Date('2026-07-17T09:00:00Z'));
    reversed = resolveDeletedAt('upsert', reversed, new Date('2026-07-17T10:00:00Z'));
    expect(reversed).not.toBeNull();
  });

  it('restore vs. a competing delete: whichever arrives last wins', () => {
    let deleteThenRestore: Date | null = null;
    deleteThenRestore = resolveDeletedAt('delete', deleteThenRestore, new Date());
    deleteThenRestore = resolveDeletedAt('restore', deleteThenRestore, new Date());
    expect(deleteThenRestore).toBeNull();

    let restoreThenDelete: Date | null = new Date('2026-07-17T08:00:00Z');
    restoreThenDelete = resolveDeletedAt('restore', restoreThenDelete, new Date());
    restoreThenDelete = resolveDeletedAt('delete', restoreThenDelete, new Date());
    expect(restoreThenDelete).not.toBeNull();
  });
});

describe('detectOverwrite', () => {
  it('flags a mutation based on an older version than what is stored', () => {
    expect(detectOverwrite(3, 5)).toBe(true);
  });

  it('does not flag a mutation based on the current version', () => {
    expect(detectOverwrite(5, 5)).toBe(false);
  });

  it('does not flag a new row (baseSeq null)', () => {
    expect(detectOverwrite(null, 5)).toBe(false);
  });

  it('does not flag a row that did not exist yet (existingSyncSeq null)', () => {
    expect(detectOverwrite(3, null)).toBe(false);
  });
});

describe('selectSince', () => {
  const rows = [
    { id: 'a', syncSeq: 1 },
    { id: 'b', syncSeq: 3 },
    { id: 'c', syncSeq: 2 },
  ];

  it('returns only rows strictly newer than the cursor', () => {
    expect(selectSince(rows, 1).changes.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('advances the cursor to the highest syncSeq returned', () => {
    expect(selectSince(rows, 1).cursor).toBe(3);
  });

  it('leaves the cursor unchanged when nothing new comes back', () => {
    expect(selectSince(rows, 10)).toEqual({ changes: [], cursor: 10 });
  });

  it('does not skip a row with an old updated_at but a high syncSeq', () => {
    // The whole point of ADR-0008: the cursor is seq-based, so a client clock
    // set far in the past never causes a row to be silently skipped.
    const skewed = [{ id: 'z', updatedAt: '1999-01-01T00:00:00Z', syncSeq: 4 }];
    expect(selectSince(skewed, 3).changes).toEqual(skewed);
  });
});
