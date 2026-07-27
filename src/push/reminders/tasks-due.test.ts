import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@/db/schema';

let rows: Task[] = [];

vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  },
}));

import { build } from './tasks-due';

// 08:00 Berlin (CEST, UTC+2) on 2026-07-15.
const AT_0800_BERLIN = new Date(Date.UTC(2026, 6, 15, 6, 0));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'id',
    updatedAt: new Date(),
    deletedAt: null,
    syncedAt: null,
    syncSeq: 1,
    title: 'Titel',
    notes: null,
    dueAt: new Date(Date.UTC(2026, 6, 15, 8, 0)),
    priority: 0,
    completedAt: null,
    recurrenceRule: null,
    createdAt: new Date(),
    parentId: null,
    ...overrides,
  };
}

describe('tasks-due build()', () => {
  it('returns null when nothing is due (0 Aufgaben)', async () => {
    rows = [];
    expect(await build(AT_0800_BERLIN)).toBeNull();
  });

  it('singular text for exactly one due task', async () => {
    rows = [task({ title: 'Steuererklärung' })];
    expect(await build(AT_0800_BERLIN)).toEqual({
      title: 'Heute fällig',
      body: 'Steuererklärung',
      url: '/aufgaben',
    });
  });

  it('lists both titles for exactly two due tasks, no "weitere"', async () => {
    rows = [task({ title: 'Eins' }), task({ title: 'Zwei' })];
    expect(await build(AT_0800_BERLIN)).toEqual({
      title: '2 Aufgaben heute fällig',
      body: 'Eins, Zwei',
      url: '/aufgaben',
    });
  });

  it('names the first two and counts the rest for five due tasks', async () => {
    rows = ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf'].map((title) => task({ title }));
    expect(await build(AT_0800_BERLIN)).toEqual({
      title: '5 Aufgaben heute fällig',
      body: 'Eins, Zwei und 3 weitere',
      url: '/aufgaben',
    });
  });

  it('a task due 23:30 Berlin today counts, one due 00:30 Berlin tomorrow does not', async () => {
    // The query itself is mocked to already exclude completed/deleted/undated tasks
    // (that's covered by the where-clause, not by this pure filter) — this test
    // proves the Berlin-day boundary the SQL result still has to pass through.
    const dueLateToday = task({ title: 'Spät heute', dueAt: new Date(Date.UTC(2026, 6, 15, 21, 30)) }); // 23:30 CEST
    const dueEarlyTomorrow = task({
      title: 'Früh morgen',
      dueAt: new Date(Date.UTC(2026, 6, 15, 22, 30)), // 00:30 CEST next day
    });
    rows = [dueLateToday, dueEarlyTomorrow];

    expect(await build(AT_0800_BERLIN)).toEqual({
      title: 'Heute fällig',
      body: 'Spät heute',
      url: '/aufgaben',
    });
  });

  it('an overdue task (past Berlin day) still counts', async () => {
    rows = [task({ title: 'Überfällig', dueAt: new Date(Date.UTC(2026, 6, 10, 6, 0)) })];
    expect(await build(AT_0800_BERLIN)).toEqual({
      title: 'Heute fällig',
      body: 'Überfällig',
      url: '/aufgaben',
    });
  });

  it('excludes completed, deleted, and not-yet-due tasks', async () => {
    rows = [
      task({ title: 'Erledigt', completedAt: new Date() }),
      task({ title: 'Gelöscht', deletedAt: new Date() }),
      task({ title: 'Morgen', dueAt: new Date(Date.UTC(2026, 6, 16, 6, 0)) }),
      task({ title: 'Übrig' }),
    ];
    expect(await build(AT_0800_BERLIN)).toEqual({
      title: 'Heute fällig',
      body: 'Übrig',
      url: '/aufgaben',
    });
  });
});
