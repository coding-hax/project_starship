import { useLiveTable } from '@/local/use-live-table';

/**
 * The subset of a task a read-only list needs. Field names match what the sync
 * engine writes into `LocalRecord.data` (SYNC_REGISTRY['tasks'].writable).
 */
export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: number;
  completedAt: string | null;
  createdAt: string;
  /** Nesting (issue #89). `null` means top-level. One level only — a child's own
   *  `parentId` is never read as a further nesting level. */
  parentId: string | null;
}

export function toTaskView(id: string, data: Record<string, unknown>): TaskView {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    notes: typeof data.notes === 'string' ? data.notes : null,
    dueAt: typeof data.dueAt === 'string' ? data.dueAt : null,
    priority: typeof data.priority === 'number' ? data.priority : 0,
    completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
    // Falls back to the epoch, not "now" — a record pulled without a createdAt
    // (pre-#88 server row) sorts to the top of the running list rather than
    // jumping to the bottom on every reload.
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
  };
}

/**
 * Strictly chronological — a running list (issue #88). New tasks land at the
 * bottom, completed ones stay exactly where they were created; "done" is shown
 * via styling (task-list__item--done), never by moving the row.
 */
export function compareTasks(a: TaskView, b: TaskView): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export interface TaskNode {
  task: TaskView;
  children: TaskView[];
  done: number;
  total: number;
}

/**
 * Groups the flat task list into one level of parent/child nesting (issue #89).
 * A task whose `parentId` points at a row that is not in the list (deleted, or
 * never arrived) falls back to top-level rather than vanishing — a visible child
 * must never be orphaned into nothing.
 */
export function groupTasks(tasks: TaskView[]): TaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, TaskView[]>();

  for (const task of tasks) {
    if (task.parentId === null || !byId.has(task.parentId)) continue;
    const siblings = childrenByParent.get(task.parentId) ?? [];
    siblings.push(task);
    childrenByParent.set(task.parentId, siblings);
  }

  return tasks
    .filter((task) => task.parentId === null || !byId.has(task.parentId))
    .sort(compareTasks)
    .map((task) => {
      const children = (childrenByParent.get(task.id) ?? []).sort(compareTasks);
      return {
        task,
        children,
        done: children.filter((child) => child.completedAt !== null).length,
        total: children.length,
      };
    });
}

/**
 * Where a drag-to-nest drop lands (issue #89). `null` means top-level — dropping
 * on empty space, on the dragged task itself, or on a target that no longer
 * exists all un-nest rather than error. Dropping on an existing child attaches to
 * *that child's* parent, since a subtask can never itself have children (one
 * level only).
 */
export function resolveNestTarget(
  draggedId: string,
  dropTargetId: string | null,
  tasks: TaskView[],
): string | null {
  if (dropTargetId === null || dropTargetId === draggedId) return null;
  const target = tasks.find((task) => task.id === dropTargetId);
  if (!target) return null;
  return target.parentId !== null ? target.parentId : target.id;
}

/**
 * Applies the "erledigte ausblenden" toggle to an already-grouped tree (issue
 * #654 AC5) without touching `done`/`total` — those keep counting every
 * child regardless, the toggle only changes what renders. A parent whose own
 * row is done drops out entirely, unless it still guards an open child (that
 * child would otherwise vanish with it); its own completed children still
 * disappear either way.
 */
export function visibleTaskNodes(nodes: TaskNode[], hideCompleted: boolean): TaskNode[] {
  if (!hideCompleted) return nodes;
  return nodes
    .filter(
      (node) =>
        node.task.completedAt === null || node.children.some((child) => child.completedAt === null),
    )
    .map((node) => ({
      ...node,
      children: node.children.filter((child) => child.completedAt === null),
    }));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Dated tasks due today (local calendar day) or earlier — the /uebersicht
 * dashboard subset (issue #87). Undated tasks and tasks due later than today are
 * excluded.
 *
 * A task checked off *today* stays in the list for the rest of the day instead of
 * vanishing under the tap (issue #228, superseding issue #87 AC3): the day's work
 * still reads as done rather than as nothing, and the row stays reachable for the
 * undo tap — the same rule the habit section already follows. It drops out on the
 * next local day; one completed earlier never comes back.
 */
export function belongsOnUebersicht(task: TaskView, now: Date = new Date()): boolean {
  if (task.dueAt === null) return false;
  const startOfToday = startOfLocalDay(now);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  if (new Date(task.dueAt) >= startOfTomorrow) return false;
  if (task.completedAt === null) return true;
  return new Date(task.completedAt) >= startOfToday;
}

/** Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). */
export function useTasks(): TaskView[] | undefined {
  return useLiveTable('tasks', toTaskView, compareTasks);
}

/** Local calendar day as `YYYY-MM-DD` — the grouping key for the "Woche"/"Erledigt" views (issue #705). */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function minutesSinceLocalMidnight(iso: string): number {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Orders tasks that already share one day group (issue #705, Q2). Within a
 * normal day: due time ascending, then priority descending, then `createdAt`
 * ascending. Within the "Überfällig" bucket the callers all share *today* as
 * their local day but not their due day, so `overdue` compares the full
 * `dueAt` (earliest-overdue first) instead of just the time-of-day.
 */
export function compareWithinDay(
  a: TaskView,
  b: TaskView,
  { overdue = false }: { overdue?: boolean } = {},
): number {
  const dueDiff = overdue
    ? (a.dueAt ?? '').localeCompare(b.dueAt ?? '')
    : minutesSinceLocalMidnight(a.dueAt ?? '') - minutesSinceLocalMidnight(b.dueAt ?? '');
  if (dueDiff !== 0) return dueDiff;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.createdAt.localeCompare(b.createdAt);
}

/** Today + the next 6 days (issue #705 AK1) — the "Woche" default's upper bound. */
const WEEK_WINDOW_DAYS = 7;

/**
 * The "Woche" view's window (issue #705, Q3): parent-driven — a node's whole
 * subtree moves as one, sorted into the window by the *parent's* `dueAt`. Kept
 * if overdue (any earlier day) or due within the next `WEEK_WINDOW_DAYS` days,
 * and still open — or completed *today* (AK7, the same "heute erledigt bleibt"
 * rule as `belongsOnUebersicht`, generalized past just "due today or earlier").
 * An undated parent never matches; its children never surface on their own
 * (v1 trade-off, documented in the ticket).
 */
export function weekWindowNodes(nodes: TaskNode[], now: Date = new Date()): TaskNode[] {
  const startOfToday = startOfLocalDay(now);
  const windowEnd = new Date(startOfToday);
  windowEnd.setDate(windowEnd.getDate() + WEEK_WINDOW_DAYS);

  return nodes.filter((node) => {
    const { dueAt, completedAt } = node.task;
    if (dueAt === null) return false;
    if (new Date(dueAt) >= windowEnd) return false;
    if (completedAt === null) return true;
    return localDayKey(new Date(completedAt)) === localDayKey(now);
  });
}

export interface DueDayGroup {
  /** `'overdue'` for the "Überfällig" bucket, otherwise a `localDayKey`. */
  dayKey: string;
  nodes: TaskNode[];
}

/**
 * Buckets already-windowed nodes by their parent's due day (issue #705 AK3):
 * "Überfällig" first, then the remaining days ascending. A day nobody is due on
 * produces no group at all — there is nothing to render a marker over. Children
 * keep the `createdAt` order `groupTasks` already gave them; only the top-level
 * nodes within a bucket are reordered, via `compareWithinDay`.
 */
export function groupByDueDay(nodes: TaskNode[], now: Date = new Date()): DueDayGroup[] {
  const startOfToday = startOfLocalDay(now);
  const buckets = new Map<string, TaskNode[]>();

  for (const node of nodes) {
    if (node.task.dueAt === null) continue;
    const due = new Date(node.task.dueAt);
    const key = due < startOfToday ? 'overdue' : localDayKey(due);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      buckets.set(key, [node]);
    }
  }

  const overdue = buckets.get('overdue');
  buckets.delete('overdue');
  const dayKeys = [...buckets.keys()].sort();

  const groups: DueDayGroup[] = [];
  if (overdue) {
    groups.push({
      dayKey: 'overdue',
      nodes: overdue.sort((a, b) => compareWithinDay(a.task, b.task, { overdue: true })),
    });
  }
  for (const dayKey of dayKeys) {
    groups.push({
      dayKey,
      nodes: buckets.get(dayKey)!.sort((a, b) => compareWithinDay(a.task, b.task)),
    });
  }
  return groups;
}

const DAY_MARKER_LABEL_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
};

/** `"Donnerstag, 13. August"` from a `localDayKey` — TZ-robust since the key's
 *  own parts, not a re-parsed instant, drive the `Date` passed to the formatter. */
function formatDayLabel(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('de-DE', DAY_MARKER_LABEL_FORMAT);
}

/**
 * The marker text over a day group (issue #705 AK3/AK7's owner precisification).
 * "Woche" spells the weekday out even for today (`"Heute · Donnerstag, 13.
 * August"`) since it is one bucket among many due days; "Erledigt" only ever
 * shows one or two relative days (`"Heute"`, `"Gestern"`) before falling back to
 * the same long label.
 */
export function formatDayMarker(dayKey: string, now: Date, view: 'woche' | 'erledigt'): string {
  if (dayKey === 'overdue') return 'Überfällig';

  const today = localDayKey(now);
  if (dayKey === today) return view === 'woche' ? `Heute · ${formatDayLabel(dayKey)}` : 'Heute';

  if (view === 'erledigt') {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey === localDayKey(yesterday)) return 'Gestern';
  }

  return formatDayLabel(dayKey);
}

export interface CompletedDayGroup {
  dayKey: string;
  tasks: TaskView[];
}

/**
 * The "Erledigt" view (issue #705, owner precisification): flat, not the
 * parent/child tree — a completed child is exactly as much "done" as a
 * completed parent, and grouping by completion day would otherwise force
 * splitting a node across two day groups. Open tasks never appear here. Days
 * ordered newest-first (most recently completed day on top); within a day,
 * `completedAt` descending — last thing checked off today sits at the top.
 */
export function completedByDay(tasks: TaskView[]): CompletedDayGroup[] {
  const buckets = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (task.completedAt === null) continue;
    const key = localDayKey(new Date(task.completedAt));
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(task);
    } else {
      buckets.set(key, [task]);
    }
  }

  return [...buckets.keys()]
    .sort()
    .reverse()
    .map((dayKey) => ({
      dayKey,
      tasks: buckets
        .get(dayKey)!
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    }));
}
