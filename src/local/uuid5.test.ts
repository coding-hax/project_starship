import { describe, expect, it } from 'vitest';
import { journalEntryId } from './uuid5';

describe('journalEntryId', () => {
  it('is a fixed regression vector for a known date (guards against namespace drift)', async () => {
    await expect(journalEntryId('2026-07-29')).resolves.toBe('d98b8d64-2bf7-5432-a0e7-d953c31727ba');
  });

  it('is deterministic: the same day always yields the same id', async () => {
    const a = await journalEntryId('2026-01-01');
    const b = await journalEntryId('2026-01-01');
    expect(a).toBe(b);
  });

  it('different days yield different ids', async () => {
    const a = await journalEntryId('2026-01-01');
    const b = await journalEntryId('2026-01-02');
    expect(a).not.toBe(b);
  });

  it('sets the UUIDv5 version and variant bits', async () => {
    const id = await journalEntryId('2026-01-01');
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
});
