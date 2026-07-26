import { describe, expect, it } from 'vitest';
import { isReadOnlyTable, isSyncTable, malformedFields, SYNC_TABLES, type Mutation } from './types';

function validMutation(id: string): Mutation {
  return {
    id,
    table: 'tasks',
    rowId: `row-${id}`,
    op: 'upsert',
    payload: { title: 'x' },
    updatedAt: new Date().toISOString(),
    baseSeq: null,
  };
}

describe('malformedFields', () => {
  it('is empty for a well-formed mutation', () => {
    expect(malformedFields(validMutation('m1'))).toEqual([]);
  });

  it('accepts a null baseSeq', () => {
    expect(malformedFields({ ...validMutation('m2'), baseSeq: null })).toEqual([]);
  });

  it('lists every violated field', () => {
    const broken = {
      table: 'not-a-table',
      rowId: 123,
      updatedAt: 456,
      baseSeq: 'nope',
    } as unknown as Mutation;

    expect(malformedFields(broken).sort()).toEqual(['baseSeq', 'rowId', 'table', 'updatedAt'].sort());
  });
});

describe('garmin (ADR-0011)', () => {
  it('garmin_activities is a sync table — it goes through the normal pull', () => {
    expect(isSyncTable('garmin_activities')).toBe(true);
    expect(SYNC_TABLES).toContain('garmin_activities');
  });

  it('garmin_activities is read-only, every other sync table is not', () => {
    expect(isReadOnlyTable('garmin_activities')).toBe(true);
    for (const table of SYNC_TABLES) {
      if (table === 'garmin_activities') continue;
      expect(isReadOnlyTable(table)).toBe(false);
    }
  });

  it('garmin_tokens never appears in SYNC_TABLES — tokens never leave the server through sync', () => {
    expect(isSyncTable('garmin_tokens')).toBe(false);
    expect(SYNC_TABLES).not.toContain('garmin_tokens');
  });
});
