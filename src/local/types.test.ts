import { describe, expect, it } from 'vitest';
import { malformedFields, type Mutation } from './types';

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
