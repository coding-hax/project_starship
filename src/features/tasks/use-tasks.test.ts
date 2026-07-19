import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  groupTasks,
  isDueTodayOrOverdue,
  resolveNestTarget,
  toTaskView,
  type TaskView,
} from './use-tasks';

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
        parentId: 'parent-1',
      }),
    ).toEqual({
      id: 'id-1',
      title: 'Milch kaufen',
      notes: 'fettarm',
      dueAt: '2026-07-15T00:00:00.000Z',
      priority: 2,
      completedAt: null,
      createdAt: '2026-07-10T00:00:00.000Z',
      parentId: 'parent-1',
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
      parentId: null,
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
    parentId: null,
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
    parentId: null,
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

describe('groupTasks', () => {
  const task = (overrides: Partial<TaskView>): TaskView => ({
    id: 'id',
    title: 'x',
    notes: null,
    dueAt: null,
    priority: 0,
    completedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    parentId: null,
    ...overrides,
  });

  it('nests children one level under their parent, dropping standalone tasks in as childless nodes', () => {
    const parent = task({ id: 'parent', createdAt: '2026-07-01T00:00:00.000Z' });
    const child = task({ id: 'child', parentId: 'parent', createdAt: '2026-07-02T00:00:00.000Z' });
    const standalone = task({ id: 'standalone', createdAt: '2026-07-03T00:00:00.000Z' });

    expect(groupTasks([parent, child, standalone])).toEqual([
      { task: parent, children: [child], done: 0, total: 1 },
      { task: standalone, children: [], done: 0, total: 0 },
    ]);
  });

  it('orders children chronologically by createdAt (issue #88), independent of insertion order', () => {
    const parent = task({ id: 'parent' });
    const older = task({ id: 'older', parentId: 'parent', createdAt: '2026-07-01T00:00:00.000Z' });
    const newer = task({ id: 'newer', parentId: 'parent', createdAt: '2026-07-05T00:00:00.000Z' });

    const [node] = groupTasks([parent, newer, older]);
    expect(node.children.map((c) => c.id)).toEqual(['older', 'newer']);
  });

  it('counts done vs. total from the children, not the parent', () => {
    const parent = task({ id: 'parent', completedAt: null });
    const doneChild = task({ id: 'a', parentId: 'parent', completedAt: '2026-07-10T00:00:00.000Z' });
    const openChild = task({ id: 'b', parentId: 'parent', completedAt: null });

    const [node] = groupTasks([parent, doneChild, openChild]);
    expect(node.done).toBe(1);
    expect(node.total).toBe(2);
  });

  it('falls back a visible child with no visible parent to top-level, never dropping it', () => {
    const orphan = task({ id: 'orphan', parentId: 'missing-parent' });

    expect(groupTasks([orphan])).toEqual([{ task: orphan, children: [], done: 0, total: 0 }]);
  });
});

describe('resolveNestTarget', () => {
  const task = (overrides: Partial<TaskView>): TaskView => ({
    id: 'id',
    title: 'x',
    notes: null,
    dueAt: null,
    priority: 0,
    completedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    parentId: null,
    ...overrides,
  });

  it('nests onto a top-level target (AK1/AK2)', () => {
    const target = task({ id: 'target' });
    expect(resolveNestTarget('dragged', 'target', [target])).toBe('target');
  });

  it('attaches to the target child\'s own parent, not the child itself (AK2)', () => {
    const parent = task({ id: 'parent' });
    const child = task({ id: 'child', parentId: 'parent' });
    expect(resolveNestTarget('dragged', 'child', [parent, child])).toBe('parent');
  });

  it('un-nests when dropped outside any task (AK5)', () => {
    const target = task({ id: 'target' });
    expect(resolveNestTarget('dragged', null, [target])).toBeNull();
  });

  it('un-nests when dropped on itself', () => {
    const target = task({ id: 'dragged' });
    expect(resolveNestTarget('dragged', 'dragged', [target])).toBeNull();
  });

  it('un-nests when the drop target no longer exists', () => {
    expect(resolveNestTarget('dragged', 'gone', [])).toBeNull();
  });
});
