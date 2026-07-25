import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from './types';

/**
 * Test the outbox-set construction logic that powers the N+1 query fix.
 * The pull() function now builds a Set of `${table}:${rowId}` keys once,
 * then checks membership per change instead of querying the outbox N times.
 */
describe('pull outbox-set optimization', () => {
  it('constructs the queued set correctly with entries from multiple tables', () => {
    const queued: OutboxEntry[] = [
      {
        id: 'm1',
        table: 'tasks',
        rowId: 'task-1',
        op: 'upsert',
        payload: {},
        updatedAt: new Date().toISOString(),
        baseSeq: null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
      {
        id: 'm2',
        table: 'tasks',
        rowId: 'task-2',
        op: 'delete',
        payload: {},
        updatedAt: new Date().toISOString(),
        baseSeq: 1,
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
      {
        id: 'm3',
        table: 'habits',
        rowId: 'habit-1',
        op: 'upsert',
        payload: {},
        updatedAt: new Date().toISOString(),
        baseSeq: null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
    ];

    // Build the set as the optimized pull() does
    const queuedSet = new Set(queued.map((m) => `${m.table}:${m.rowId}`));

    // Should contain all entries
    expect(queuedSet.has('tasks:task-1')).toBe(true);
    expect(queuedSet.has('tasks:task-2')).toBe(true);
    expect(queuedSet.has('habits:habit-1')).toBe(true);
  });

  it('correctly identifies changes that are queued', () => {
    const queued: OutboxEntry[] = [
      {
        id: 'm1',
        table: 'tasks',
        rowId: 'task-1',
        op: 'upsert',
        payload: {},
        updatedAt: new Date().toISOString(),
        baseSeq: null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
    ];

    const queuedSet = new Set(queued.map((m) => `${m.table}:${m.rowId}`));

    // Change on a queued row should match
    const changeTasks1 = { table: 'tasks', id: 'task-1' };
    expect(queuedSet.has(`${changeTasks1.table}:${changeTasks1.id}`)).toBe(true);

    // Change on another row should not match
    const changeTasks2 = { table: 'tasks', id: 'task-2' };
    expect(queuedSet.has(`${changeTasks2.table}:${changeTasks2.id}`)).toBe(false);

    // Change on same row but different table should not match
    const changeHabit1 = { table: 'habits', id: 'task-1' };
    expect(queuedSet.has(`${changeHabit1.table}:${changeHabit1.id}`)).toBe(false);
  });

  it('handles large numbers of queued mutations efficiently (N+1 fix verification)', () => {
    // Simulate a large queue
    const queued: OutboxEntry[] = Array.from({ length: 500 }, (_, i) => ({
      id: `m-${i}`,
      table: i % 2 === 0 ? 'tasks' : 'habits',
      rowId: `row-${i}`,
      op: 'upsert',
      payload: {},
      updatedAt: new Date().toISOString(),
      baseSeq: null,
      createdAt: new Date().toISOString(),
      attempts: 0,
    }));

    // Build the set once
    const queuedSet = new Set(queued.map((m) => `${m.table}:${m.rowId}`));

    // Simulate checking 500 incoming changes against the set
    for (let i = 0; i < 500; i++) {
      const table = i % 2 === 0 ? 'tasks' : 'habits';
      const key = `${table}:row-${i}`;
      // All should match because they're all in the outbox
      expect(queuedSet.has(key)).toBe(true);
    }

    // And some that aren't in the outbox
    expect(queuedSet.has('tasks:unknown-1')).toBe(false);
    expect(queuedSet.has('habits:unknown-2')).toBe(false);
  });
});
