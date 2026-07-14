import { describe, expect, it } from 'vitest';
import { compareTasks, toTaskView, type TaskView } from './use-tasks';

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
