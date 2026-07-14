import { describe, expect, it } from 'vitest';
import { missingRequired, writableFields } from './sync-tables';

describe('writableFields', () => {
  it('keeps the whitelisted fields', () => {
    expect(writableFields('sync_state', { key: 'a', value: { n: 1 } })).toEqual({
      key: 'a',
      value: { n: 1 },
    });
  });

  it('drops fields a client must never set', () => {
    // The whole point of the whitelist: without it a mutation could backdate
    // updated_at and walk straight through last-write-wins.
    const fields = writableFields('sync_state', {
      key: 'a',
      value: 1,
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
      deletedAt: null,
    });

    expect(fields).toEqual({ key: 'a', value: 1 });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });

  it('omits absent fields rather than nulling them — payloads are partial', () => {
    // A mutation that only touches `value` must not wipe `key`.
    expect(writableFields('sync_state', { value: 2 })).toEqual({ value: 2 });
  });
});

describe('missingRequired', () => {
  it('passes when every NOT NULL column is present', () => {
    expect(missingRequired('sync_state', { key: 'a', value: 1 })).toEqual([]);
  });

  it('names what a create is missing, so the push can 400 instead of 500', () => {
    expect(missingRequired('sync_state', { value: 1 })).toEqual(['key']);
    expect(missingRequired('sync_state', {})).toEqual(['key', 'value']);
  });
});
