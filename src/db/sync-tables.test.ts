import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { missingRequired, SYNC_REGISTRY, writableFields } from './sync-tables';

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

describe('writableFields for tasks', () => {
  it('keeps the whitelisted fields', () => {
    expect(
      writableFields('tasks', {
        title: 'Milch kaufen',
        notes: 'fettarm',
        dueAt: '2026-07-15T00:00:00.000Z',
        priority: 1,
        completedAt: null,
        recurrenceRule: null,
      }),
    ).toEqual({
      title: 'Milch kaufen',
      notes: 'fettarm',
      // A timestamp column needs a Date to insert/update — the wire format only has
      // the ISO string.
      dueAt: new Date('2026-07-15T00:00:00.000Z'),
      priority: 1,
      completedAt: null,
      recurrenceRule: null,
    });
  });

  it('converts a timestamp field to a Date, leaving null as-is', () => {
    const fields = writableFields('tasks', {
      title: 'Wäsche',
      completedAt: '2026-07-15T09:00:00.000Z',
    });

    expect(fields.completedAt).toBeInstanceOf(Date);
    expect((fields.completedAt as Date).toISOString()).toBe('2026-07-15T09:00:00.000Z');

    expect(writableFields('tasks', { title: 'Wäsche', completedAt: null }).completedAt).toBeNull();
  });

  it('drops fields a client must never set', () => {
    const fields = writableFields('tasks', {
      title: 'Milch kaufen',
      id: 'attacker-chosen',
      updatedAt: '1970-01-01T00:00:00.000Z',
      deletedAt: null,
    });

    expect(fields).toEqual({ title: 'Milch kaufen' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('updatedAt');
  });
});

describe('writableFields for tasks.parentId (issue #89)', () => {
  it('passes a uuid through unchanged — parentId is not a timestamp column', () => {
    expect(
      writableFields('tasks', { title: 'Wäsche', parentId: 'parent-uuid' }).parentId,
    ).toBe('parent-uuid');
  });

  it('allows null — un-nesting back to top-level', () => {
    expect(writableFields('tasks', { title: 'Wäsche', parentId: null }).parentId).toBeNull();
  });

  it('is not required — a create without parentId is still valid', () => {
    expect(missingRequired('tasks', { title: 'Wäsche' })).toEqual([]);
  });
});

describe('missingRequired for tasks', () => {
  it('passes when title is present', () => {
    expect(missingRequired('tasks', { title: 'Milch kaufen' })).toEqual([]);
  });

  it('names the missing title, so the push can 400 instead of 500', () => {
    expect(missingRequired('tasks', {})).toEqual(['title']);
  });
});

describe('sync columns present', () => {
  // A synchronised table without these carries no way to soft-delete or resolve
  // conflicts — typecheck alone would not catch a table that forgets to spread
  // `syncColumns` (SYNC_REGISTRY types `table` as `unknown`).
  const requiredColumns = ['id', 'updated_at', 'deleted_at', 'synced_at'];

  it.each(Object.keys(SYNC_REGISTRY))('%s carries every sync column', (name) => {
    const entry = SYNC_REGISTRY[name as keyof typeof SYNC_REGISTRY];
    const columns = getTableColumns(entry.table as PgTable);
    const columnNames = Object.values(columns).map((column) => column.name);

    for (const required of requiredColumns) {
      expect(columnNames).toContain(required);
    }
  });
});
