import { describe, expect, it } from 'vitest';
import { compareTasks, isDueTodayOrOverdue, toTaskView, type TaskView } from './use-tasks';

describe('toTaskView', () => {
  it('reads the writable task fields out of a local record', () => {
    expect(
      toTaskView('id-1', {
        title: 'Milch kaufen',
        notes: 'fettarm',
        dueAt: '2026-07-15T00:00:00.000Z',
        priority: 2,
        completedAt: null,
        createdAt: '2026-07-10T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'id-1',
      title: 'Milch kaufen',
      notes: 'fettarm',
      dueAt: '2026-07-15T00:00:00.000Z',
      priority: 2,
      completedAt: null,
      createdAt: '2026-07-10T00:00:00.000Z',
    });
  });

  it('falls back to safe defaults for a record still missing fields', () => {
    expect(toTaskView('id-2', {})).toEqual({
      id: 'id-2',
      title: '',
      notes: null,
      dueAt: null,
      priority: 0,
      completedAt: null,
      createdAt: new Date(0).toISOString(),
    });
  });
});

describe('compareTasks', () => {
  const task = (overrides: Partial<TaskView>): TaskView => ({
    id: 'id',
    title: 'x',
    notes: null,
    dueAt: null,
    priority: 0,
    completedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  });

  it('sorts strictly by createdAt, ascending', () => {
    const later = task({ id: 'later', createdAt: '2026-07-16T00:00:00.000Z' });
    const sooner = task({ id: 'sooner', createdAt: '2026-07-15T00:00:00.000Z' });

    expect([later, sooner].sort(compareTasks)).toEqual([sooner, later]);
  });

  it('leaves a completed task in its creation-order position, not moved to the end', () => {
    const doneFirst = task({
      id: 'done',
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-14T00:00:00.000Z',
    });
    const openLater = task({ id: 'open', createdAt: '2026-07-02T00:00:00.000Z' });

    expect([openLater, doneFirst].sort(compareTasks)).toEqual([doneFirst, openLater]);
  });

  it('ignores due date entirely — createdAt is the only sort key', () => {
    const earlierDueLaterCreated = task({
      id: 'a',
      dueAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    const laterDueEarlierCreated = task({
      id: 'b',
      dueAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-07-05T00:00:00.000Z',
    });

    expect([earlierDueLaterCreated, laterDueEarlierCreated].sort(compareTasks)).toEqual([
      laterDueEarlierCreated,
      earlierDueLaterCreated,
    ]);
  });
});

describe('isDueTodayOrOverdue', () => {
  const task = (overrides: Partial<TaskView>): TaskView => ({
    id: 'id',
    title: 'x',
    notes: null,
    dueAt: null,
    priority: 0,
    completedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  });

  const now = new Date('2026-07-18T12:00:00.000Z');

  it('is true for an open task overdue from an earlier day', () => {
    expect(isDueTodayOrOverdue(task({ dueAt: '2026-07-17T09:00:00.000Z' }), now)).toBe(true);
  });

  it('is true for an open task due later today, even though the time has not passed yet', () => {
    expect(isDueTodayOrOverdue(task({ dueAt: '2026-07-18T18:00:00.000Z' }), now)).toBe(true);
  });

  it('is false for an open task due on a future day', () => {
    expect(isDueTodayOrOverdue(task({ dueAt: '2026-07-19T09:00:00.000Z' }), now)).toBe(false);
  });

  it('is false for an undated task', () => {
    expect(isDueTodayOrOverdue(task({ dueAt: null }), now)).toBe(false);
  });

  it('is false for a completed task, even if its due date was today or earlier', () => {
    expect(
      isDueTodayOrOverdue(
        task({ dueAt: '2026-07-17T09:00:00.000Z', completedAt: '2026-07-17T10:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });
});
