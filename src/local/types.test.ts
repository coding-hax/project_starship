import { describe, expect, it } from 'vitest';
import {
  isSyncTable,
  malformedFields,
  NATURAL_KEYS,
  naturalKeyOf,
  SYNC_TABLES,
  type Mutation,
} from './types';

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

describe('Garmin ist ausgebaut (#1200, löst ADR-0011 ab)', () => {
  it('garmin_activities is not a sync table any more', () => {
    expect(isSyncTable('garmin_activities')).toBe(false);
    expect(SYNC_TABLES).not.toContain('garmin_activities');
  });

  it('garmin_tokens never appears in SYNC_TABLES — tokens never leave the server through sync', () => {
    expect(isSyncTable('garmin_tokens')).toBe(false);
    expect(SYNC_TABLES).not.toContain('garmin_tokens');
  });
});

describe('events/event_exceptions (issue #552, S1 of #473)', () => {
  it('both are sync tables', () => {
    expect(isSyncTable('events')).toBe(true);
    expect(isSyncTable('event_exceptions')).toBe(true);
  });

  it('event_exceptions has the natural key (eventId, originalDate) — a series referenced, not a list on events (AC6)', () => {
    expect(NATURAL_KEYS.event_exceptions).toEqual(['eventId', 'originalDate']);
    expect(NATURAL_KEYS.events).toBeUndefined();
  });

  it('naturalKeyOf joins eventId + originalDate so two devices moving the same instance collapse to one row', () => {
    expect(
      naturalKeyOf('event_exceptions', { eventId: 'event-1', originalDate: '2026-10-25' }),
    ).toBe('event-1:2026-10-25');
  });

  it('naturalKeyOf is null for an incomplete payload — a partial update missing one of the key fields', () => {
    expect(naturalKeyOf('event_exceptions', { eventId: 'event-1' })).toBeNull();
  });
});

describe('category_colors (issue #660)', () => {
  it('is a sync table', () => {
    expect(isSyncTable('category_colors')).toBe(true);
  });

  it('has the natural key (category) — two devices choosing offline collapse to one row', () => {
    expect(NATURAL_KEYS.category_colors).toEqual(['category']);
  });

  it('naturalKeyOf reads the category', () => {
    expect(naturalKeyOf('category_colors', { category: 'arbeit' })).toBe('arbeit');
  });

  it('naturalKeyOf is null for an incomplete payload', () => {
    expect(naturalKeyOf('category_colors', {})).toBeNull();
  });
});
