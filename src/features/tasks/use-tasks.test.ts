import { describe, expect, it } from 'vitest';
import {
  belongsOnUebersicht,
  compareTasks,
  compareWithinDay,
  completedByDay,
  formatDayMarker,
  groupByDueDay,
  groupTasks,
  localDayKey,
  openTaskNodes,
  resolveNestTarget,
  toTaskView,
  undatedOpenNodes,
  weekWindowNodes,
  type TaskNode,
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

describe('belongsOnUebersicht', () => {
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
    expect(belongsOnUebersicht(task({ dueAt: '2026-07-17T09:00:00.000Z' }), now)).toBe(true);
  });

  it('is true for an open task due later today, even though the time has not passed yet', () => {
    expect(belongsOnUebersicht(task({ dueAt: '2026-07-18T18:00:00.000Z' }), now)).toBe(true);
  });

  it('is false for an open task due on a future day', () => {
    expect(belongsOnUebersicht(task({ dueAt: '2026-07-19T09:00:00.000Z' }), now)).toBe(false);
  });

  it('is false for an undated task', () => {
    expect(belongsOnUebersicht(task({ dueAt: null }), now)).toBe(false);
  });

  // Checked off today, the row stays for the rest of the day (issue #228) — it is
  // the day's work, and the undo tap has to stay reachable.
  it('is true for a task completed today whose due date was today or earlier', () => {
    expect(
      belongsOnUebersicht(
        task({ dueAt: '2026-07-17T09:00:00.000Z', completedAt: '2026-07-18T08:00:00.000Z' }),
        now,
      ),
    ).toBe(true);
  });

  it('is false for a task completed on an earlier day', () => {
    expect(
      belongsOnUebersicht(
        task({ dueAt: '2026-07-17T09:00:00.000Z', completedAt: '2026-07-17T10:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });

  it('is false for a task completed today but due on a future day — it was never listed', () => {
    expect(
      belongsOnUebersicht(
        task({ dueAt: '2026-07-19T09:00:00.000Z', completedAt: '2026-07-18T08:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });

  it('is false for an undated task completed today', () => {
    expect(belongsOnUebersicht(task({ completedAt: '2026-07-18T08:00:00.000Z' }), now)).toBe(false);
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
    const doneChild = task({
      id: 'a',
      parentId: 'parent',
      completedAt: '2026-07-10T00:00:00.000Z',
    });
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

describe('openTaskNodes', () => {
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

  it('drops a completed top-level task with no children', () => {
    const nodes = groupTasks([task({ id: 'done', completedAt: '2026-07-02T00:00:00.000Z' })]);
    expect(openTaskNodes(nodes)).toEqual([]);
  });

  it('keeps an open top-level task', () => {
    const nodes = groupTasks([task({ id: 'open' })]);
    expect(openTaskNodes(nodes)).toEqual(nodes);
  });

  it('hides a completed child but keeps its open parent', () => {
    const parent = task({ id: 'parent' });
    const doneChild = task({
      id: 'a',
      parentId: 'parent',
      completedAt: '2026-07-02T00:00:00.000Z',
    });
    const openChild = task({ id: 'b', parentId: 'parent' });
    const nodes = groupTasks([parent, doneChild, openChild]);

    const [node] = openTaskNodes(nodes);
    expect(node.children.map((c) => c.id)).toEqual(['b']);
  });

  it('keeps a completed parent visible when it still guards an open child, dropping only its completed children', () => {
    const parent = task({ id: 'parent', completedAt: '2026-07-02T00:00:00.000Z' });
    const openChild = task({ id: 'open', parentId: 'parent' });
    const doneChild = task({
      id: 'done',
      parentId: 'parent',
      completedAt: '2026-07-02T00:00:00.000Z',
    });
    const nodes = groupTasks([parent, openChild, doneChild]);

    const visible = openTaskNodes(nodes);
    expect(visible).toHaveLength(1);
    expect(visible[0].task.id).toBe('parent');
    expect(visible[0].children.map((c) => c.id)).toEqual(['open']);
  });

  it('drops a completed parent whose children are all completed too', () => {
    const parent = task({ id: 'parent', completedAt: '2026-07-02T00:00:00.000Z' });
    const doneChild = task({
      id: 'child',
      parentId: 'parent',
      completedAt: '2026-07-02T00:00:00.000Z',
    });
    const nodes = groupTasks([parent, doneChild]);

    expect(openTaskNodes(nodes)).toEqual([]);
  });

  it("never changes a kept node's done/total — filtering changes display, not data", () => {
    const parent = task({ id: 'parent', completedAt: '2026-07-02T00:00:00.000Z' });
    const openChild = task({ id: 'open', parentId: 'parent' });
    const doneChild = task({
      id: 'done',
      parentId: 'parent',
      completedAt: '2026-07-02T00:00:00.000Z',
    });
    const nodes = groupTasks([parent, openChild, doneChild]);

    const [node] = openTaskNodes(nodes);
    expect(node.done).toBe(1);
    expect(node.total).toBe(2);
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

  it("attaches to the target child's own parent, not the child itself (AK2)", () => {
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

/** Local-time construction, never a re-parsed 'Z' instant — the same value must
 *  read back as the same calendar day and clock time regardless of which
 *  timezone runs the suite. */
function localIso(year: number, month: number, day: number, hours = 0, minutes = 0): string {
  return new Date(year, month - 1, day, hours, minutes).toISOString();
}

describe('localDayKey', () => {
  it('formats a local calendar day as YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 6, 8, 23, 30))).toBe('2026-07-08');
  });

  it('pads single-digit months and days', () => {
    expect(localDayKey(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05');
  });
});

describe('compareWithinDay', () => {
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

  it('orders a normal day by due time ascending', () => {
    const evening = task({ id: 'evening', dueAt: localIso(2026, 7, 18, 18, 0) });
    const morning = task({ id: 'morning', dueAt: localIso(2026, 7, 18, 8, 0) });

    expect([evening, morning].sort((a, b) => compareWithinDay(a, b))).toEqual([morning, evening]);
  });

  it('breaks a same-time tie by priority descending', () => {
    const low = task({ id: 'low', dueAt: localIso(2026, 7, 18, 9, 0), priority: 0 });
    const urgent = task({ id: 'urgent', dueAt: localIso(2026, 7, 18, 9, 0), priority: 2 });

    expect([low, urgent].sort((a, b) => compareWithinDay(a, b))).toEqual([urgent, low]);
  });

  it('breaks a same-time-and-priority tie by createdAt ascending', () => {
    const later = task({
      id: 'later',
      dueAt: localIso(2026, 7, 18, 9, 0),
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    const sooner = task({
      id: 'sooner',
      dueAt: localIso(2026, 7, 18, 9, 0),
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    expect([later, sooner].sort((a, b) => compareWithinDay(a, b))).toEqual([sooner, later]);
  });

  it('orders the Überfällig bucket by the full due date ascending, not time-of-day', () => {
    // Due later in the day but on an earlier calendar date still sorts first —
    // the overdue bucket spans several days, so time-of-day alone would be wrong.
    const dueEarlierDayLateTime = task({ id: 'a', dueAt: localIso(2026, 7, 10, 20, 0) });
    const dueLaterDayEarlyTime = task({ id: 'b', dueAt: localIso(2026, 7, 12, 6, 0) });

    expect(
      [dueLaterDayEarlyTime, dueEarlierDayLateTime].sort((a, b) =>
        compareWithinDay(a, b, { overdue: true }),
      ),
    ).toEqual([dueEarlierDayLateTime, dueLaterDayEarlyTime]);
  });
});

describe('weekWindowNodes', () => {
  const now = new Date(2026, 6, 18, 12, 0); // Samstag, 18. Juli 2026, local

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

  const node = (t: TaskView, children: TaskView[] = []): TaskNode => ({
    task: t,
    children,
    done: children.filter((c) => c.completedAt !== null).length,
    total: children.length,
  });

  it('keeps an open task overdue by many days', () => {
    const nodes = [node(task({ id: 'old', dueAt: localIso(2026, 7, 1, 9, 0) }))];
    expect(weekWindowNodes(nodes, now)).toEqual(nodes);
  });

  it('keeps a task due on the last day of the window (today + 6)', () => {
    const nodes = [node(task({ id: 'edge', dueAt: localIso(2026, 7, 24, 23, 59) }))];
    expect(weekWindowNodes(nodes, now)).toEqual(nodes);
  });

  it('drops a task due the day after the window closes (today + 7)', () => {
    const nodes = [node(task({ id: 'too-far', dueAt: localIso(2026, 7, 25, 0, 0) }))];
    expect(weekWindowNodes(nodes, now)).toEqual([]);
  });

  it('drops an undated parent, even with a dated child (v1 trade-off)', () => {
    const child = task({ id: 'child', parentId: 'parent', dueAt: localIso(2026, 7, 19, 9, 0) });
    const nodes = [node(task({ id: 'parent', dueAt: null }), [child])];
    expect(weekWindowNodes(nodes, now)).toEqual([]);
  });

  it('drops a task within the window that was completed on an earlier day', () => {
    const nodes = [
      node(
        task({
          id: 'stale-done',
          dueAt: localIso(2026, 7, 19, 9, 0),
          completedAt: localIso(2026, 7, 17, 9, 0),
        }),
      ),
    ];
    expect(weekWindowNodes(nodes, now)).toEqual([]);
  });

  it('keeps an overdue task completed today (AK7, same rule as belongsOnUebersicht)', () => {
    const nodes = [
      node(
        task({
          id: 'done-today',
          dueAt: localIso(2026, 7, 10, 9, 0),
          completedAt: localIso(2026, 7, 18, 8, 0),
        }),
      ),
    ];
    expect(weekWindowNodes(nodes, now)).toEqual(nodes);
  });
});

describe('undatedOpenNodes', () => {
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

  const node = (t: TaskView, children: TaskView[] = []): TaskNode => ({
    task: t,
    children,
    done: children.filter((c) => c.completedAt !== null).length,
    total: children.length,
  });

  it('keeps an undated, open top-level task', () => {
    const nodes = [node(task({ id: 'undated' }))];
    expect(undatedOpenNodes(nodes)).toEqual(nodes);
  });

  it('drops a dated task, even an overdue one', () => {
    const nodes = [node(task({ id: 'dated', dueAt: '2026-07-01T09:00:00.000Z' }))];
    expect(undatedOpenNodes(nodes)).toEqual([]);
  });

  it('drops an undated task that is already completed', () => {
    const nodes = [node(task({ id: 'done', completedAt: '2026-07-01T09:00:00.000Z' }))];
    expect(undatedOpenNodes(nodes)).toEqual([]);
  });

  it('keeps an undated parent together with its (dated) children', () => {
    const child = task({ id: 'child', parentId: 'parent', dueAt: '2026-07-19T09:00:00.000Z' });
    const nodes = [node(task({ id: 'parent' }), [child])];
    expect(undatedOpenNodes(nodes)).toEqual(nodes);
  });
});

describe('groupByDueDay', () => {
  const now = new Date(2026, 6, 18, 12, 0); // Samstag, 18. Juli 2026, local

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

  const node = (t: TaskView, children: TaskView[] = []): TaskNode => ({
    task: t,
    children,
    done: children.filter((c) => c.completedAt !== null).length,
    total: children.length,
  });

  it('puts the Überfällig bucket first, then the remaining days ascending', () => {
    const nodes = [
      node(task({ id: 'day20', dueAt: localIso(2026, 7, 20, 9, 0) })),
      node(task({ id: 'overdue', dueAt: localIso(2026, 7, 10, 9, 0) })),
      node(task({ id: 'today', dueAt: localIso(2026, 7, 18, 9, 0) })),
    ];

    expect(groupByDueDay(nodes, now).map((g) => g.dayKey)).toEqual([
      'overdue',
      '2026-07-18',
      '2026-07-20',
    ]);
  });

  it('produces no group at all for a day nobody is due on', () => {
    const nodes = [node(task({ id: 'a', dueAt: localIso(2026, 7, 18, 9, 0) }))];
    // 19./20./21. etc. never show up — only 18. does.
    expect(groupByDueDay(nodes, now).map((g) => g.dayKey)).toEqual(['2026-07-18']);
  });

  it('sorts nodes within a day by compareWithinDay', () => {
    const nodes = [
      node(task({ id: 'evening', dueAt: localIso(2026, 7, 18, 18, 0) })),
      node(task({ id: 'morning', dueAt: localIso(2026, 7, 18, 8, 0) })),
    ];

    const [group] = groupByDueDay(nodes, now);
    expect(group.nodes.map((n) => n.task.id)).toEqual(['morning', 'evening']);
  });

  it("keeps a node's children in their existing createdAt order, untouched by the day sort", () => {
    const olderChild = task({
      id: 'older-child',
      parentId: 'parent',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const newerChild = task({
      id: 'newer-child',
      parentId: 'parent',
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    const nodes = [
      node(task({ id: 'parent', dueAt: localIso(2026, 7, 18, 9, 0) }), [olderChild, newerChild]),
    ];

    const [group] = groupByDueDay(nodes, now);
    expect(group.nodes[0].children.map((c) => c.id)).toEqual(['older-child', 'newer-child']);
  });
});

describe('formatDayMarker', () => {
  const now = new Date(2026, 6, 18, 12, 0); // Samstag, 18. Juli 2026, local

  it('reads "Überfällig" for the overdue bucket, in every view', () => {
    expect(formatDayMarker('overdue', now, 'woche')).toBe('Überfällig');
    expect(formatDayMarker('overdue', now, 'erledigt')).toBe('Überfällig');
  });

  it('spells today out with the weekday in "woche"', () => {
    expect(formatDayMarker('2026-07-18', now, 'woche')).toBe('Heute · Samstag, 18. Juli');
  });

  it('shortens today to just "Heute" in "erledigt"', () => {
    expect(formatDayMarker('2026-07-18', now, 'erledigt')).toBe('Heute');
  });

  it('reads "Gestern" for yesterday, only in "erledigt"', () => {
    expect(formatDayMarker('2026-07-17', now, 'erledigt')).toBe('Gestern');
    expect(formatDayMarker('2026-07-17', now, 'woche')).toBe('Freitag, 17. Juli');
  });

  it('falls back to the full weekday label for any other day', () => {
    expect(formatDayMarker('2026-07-20', now, 'woche')).toBe('Montag, 20. Juli');
    expect(formatDayMarker('2026-07-10', now, 'erledigt')).toBe('Freitag, 10. Juli');
  });
});

describe('completedByDay', () => {
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

  it('excludes open tasks', () => {
    expect(completedByDay([task({ id: 'open' })])).toEqual([]);
  });

  it('orders days newest-first', () => {
    const groups = completedByDay([
      task({ id: 'old', completedAt: localIso(2026, 7, 10, 9, 0) }),
      task({ id: 'new', completedAt: localIso(2026, 7, 17, 9, 0) }),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-07-17', '2026-07-10']);
  });

  it('orders tasks within a day by completedAt descending', () => {
    const groups = completedByDay([
      task({ id: 'first', completedAt: localIso(2026, 7, 18, 8, 0) }),
      task({ id: 'last', completedAt: localIso(2026, 7, 18, 16, 0) }),
    ]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['last', 'first']);
  });

  it('lists a completed child flat, alongside a completed parent, not nested', () => {
    const parent = task({ id: 'parent', completedAt: localIso(2026, 7, 18, 8, 0) });
    const child = task({
      id: 'child',
      parentId: 'parent',
      completedAt: localIso(2026, 7, 18, 9, 0),
    });

    const [group] = completedByDay([parent, child]);
    expect(group.tasks.map((t) => t.id)).toEqual(['child', 'parent']);
  });
});
