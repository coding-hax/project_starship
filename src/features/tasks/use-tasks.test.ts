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
      }),
    ).toEqual({
      id: 'id-1',
      title: 'Milch kaufen',
      notes: 'fettarm',
      dueAt: '2026-07-15T00:00:00.000Z',
      priority: 2,
      completedAt: null,
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
    ...overrides,
  });

  it('sorts open tasks by due date, ascending', () => {
    const later = task({ id: 'later', dueAt: '2026-07-16T00:00:00.000Z' });
    const sooner = task({ id: 'sooner', dueAt: '2026-07-15T00:00:00.000Z' });

    expect([later, sooner].sort(compareTasks)).toEqual([sooner, later]);
  });

  it('puts undated open tasks after dated ones', () => {
    const undated = task({ id: 'undated' });
    const dated = task({ id: 'dated', dueAt: '2026-07-15T00:00:00.000Z' });

    expect([undated, dated].sort(compareTasks)).toEqual([dated, undated]);
  });

  it('puts every completed task after every open task, regardless of due date', () => {
    const doneWithEarlyDue = task({
      id: 'done',
      dueAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-14T00:00:00.000Z',
    });
    const openWithLateDue = task({ id: 'open', dueAt: '2026-08-01T00:00:00.000Z' });

    expect([doneWithEarlyDue, openWithLateDue].sort(compareTasks)).toEqual([
      openWithLateDue,
      doneWithEarlyDue,
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
