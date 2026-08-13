'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import { OfflineNotice } from '@/ui/offline-notice';
import { useBlockReady } from '@/ui/overview-ready';
import { SegmentedControl, type SegmentedOption } from '@/ui/segmented-control';
import { Toast } from '@/ui/toast';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import { useHideCompletedTasks } from './use-hide-completed-tasks';
import {
  belongsOnUebersicht,
  completedByDay,
  formatDayMarker,
  groupByDueDay,
  groupTasks,
  localDayKey,
  resolveNestTarget,
  useTasks,
  visibleTaskNodes,
  weekWindowNodes,
  type TaskNode,
  type TaskView,
} from './use-tasks';

/** The `/aufgaben` view switcher (issue #705 AK2) — ephemeral, never persisted;
 *  a fresh navigation always lands back on `'woche'`. Irrelevant for the
 *  `dueTodayOnly` (/uebersicht) instance, which has no switcher and stays flat. */
type ViewMode = 'woche' | 'alle' | 'erledigt';

const VIEW_OPTIONS: SegmentedOption<ViewMode>[] = [
  { value: 'woche', label: 'Woche' },
  { value: 'alle', label: 'Alle' },
  { value: 'erledigt', label: 'Erledigt' },
];

/**
 * One `<li>` worth of row, flattened out of the parent/child tree (issue #430)
 * — `useListPresence` needs one flat, uniformly-keyed array to diff against;
 * grouped `Fragment`s per parent had no single key per row to track. `kind`
 * carries just enough of the originating node to rebuild the same props
 * `TaskItem` always got, nothing more. `marker` (issue #705 AK3) is a day
 * heading, never a task — rendered `role="presentation"` so it never counts as
 * a `listitem`.
 */
type TaskRow =
  | { id: string; kind: 'flat'; task: TaskView }
  | { id: string; kind: 'parent'; node: TaskNode }
  | { id: string; kind: 'child'; node: TaskNode; child: TaskView }
  | { id: string; kind: 'marker'; label: string };

/** A node's parent row plus its children rows, in that order. */
function nodeRows(node: TaskNode): TaskRow[] {
  return [
    { id: node.task.id, kind: 'parent' as const, node },
    ...node.children.map((child) => ({ id: child.id, kind: 'child' as const, node, child })),
  ];
}

export interface TaskListProps {
  /**
   * Restricts the list to tasks due today or overdue, still open or checked off
   * today — the /uebersicht dashboard subset (issue #87, issue #228). Everything
   * else (editor, undo toasts, offline notice) stays the same so the two lists
   * don't drift apart.
   */
  dueTodayOnly?: boolean;
  /**
   * Id of a visible heading that already names this list (issue #157) — the list
   * is labelled by it via `aria-labelledby` instead of carrying its own
   * `aria-label`, so a screen reader doesn't announce both back to back.
   */
  headingId?: string;
  /**
   * Whether the chat-style scroll anchor (issue #88, below) may run. Default
   * `true` for `/aufgaben`, where this list *is* the page and owns the
   * document's scroll. An embedded call site (`/uebersicht`, issue #647) has
   * no scroll container of its own — `scrollIntoView` would scroll the whole
   * document out from under the sections above it — so it passes `false`.
   * Not derived from `dueTodayOnly`: that is a data filter, this is a layout fact.
   */
  anchorOnMount?: boolean;
}

export function TaskList({
  dueTodayOnly = false,
  headingId,
  anchorOnMount = true,
}: TaskListProps = {}) {
  const allTasks = useTasks();
  // `useMemo`'d on `[allTasks, dueTodayOnly]` — `allTasks` is referentially
  // stable across renders that aren't a real live-query emission (see
  // use-live-table.ts), and `useListPresence` below needs that stability to
  // tell "the data changed" apart from "this component re-rendered for some
  // other reason" (editingTaskId, collapsed, …).
  const tasks = useMemo(
    () => (dueTodayOnly ? allTasks?.filter((task) => belongsOnUebersicht(task)) : allTasks),
    [allTasks, dueTodayOnly],
  );
  // Inert on /aufgaben, where this list is the whole screen and has nothing below
  // it to push; on /uebersicht it joins the shared reveal point (issue #642).
  useBlockReady(allTasks !== undefined);
  const online = useOnline();
  // Global device-local toggle (issue #654) — only applied below on /aufgaben
  // (`!dueTodayOnly`), never on the /uebersicht subset (AC7).
  const { hideCompleted } = useHideCompletedTasks();
  const {
    toggleComplete,
    undo: completeUndo,
    handleUndo: handleCompleteUndo,
    dismissUndo: dismissCompleteUndo,
  } = useCompleteTask();
  const {
    deleteTask,
    undo: deleteUndo,
    handleUndo: handleDeleteUndo,
    dismissUndo: dismissDeleteUndo,
  } = useDeleteTask();
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Ephemeral, not persisted (issue #705 AK2) — a fresh /aufgaben navigation
  // always starts back on "Woche". Unused on the `dueTodayOnly` instance,
  // which never renders the switcher and never changes it away from the default.
  const [view, setView] = useState<ViewMode>('woche');
  // Ephemeral, not persisted (per-ticket decision) — default expanded, so a
  // reload never hides subtasks the user hasn't deliberately collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // What a drop would do *right now* (issue #451) — set on pick-up and on every
  // move while lifted, cleared on drop and on cancel. `targetId` is still the raw
  // row under the pointer; the one-level rule is applied below, so the preview
  // cannot drift from what `handleNest` actually does.
  const [dragPreview, setDragPreview] = useState<{
    draggedId: string;
    targetId: string | null;
  } | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const anchoredRef = useRef(false);

  const editingTask = allTasks?.find((task) => task.id === editingTaskId) ?? null;
  // Grouped from the full list, not the /uebersicht-filtered `tasks` — nesting still
  // needs the whole task graph even when the view itself renders flat (issue #89).
  const nodes = useMemo(() => groupTasks(allTasks ?? []), [allTasks]);
  const editingNode = nodes.find((node) => node.task.id === editingTaskId);
  const nestCandidates = nodes
    .filter((node) => node.task.id !== editingTaskId)
    .map((node) => node.task);

  /**
   * `rows` plus the two counts AK6/AK9 need beyond what a flat row list can
   * carry (issue #705). `now` is read once per recompute here, not on every
   * render — the grouping only needs to reflect "now" when the underlying
   * data or the view actually changes.
   */
  const viewModel = useMemo(() => {
    if (dueTodayOnly) {
      const flatRows = (tasks ?? []).map((task) => ({ id: task.id, kind: 'flat' as const, task }));
      return { rows: flatRows, undatedOpenCount: 0, hasFutureGroup: false };
    }

    if (view === 'erledigt') {
      const now = new Date();
      const flatRows = completedByDay(allTasks ?? []).flatMap((group) => [
        {
          id: `marker:${group.dayKey}`,
          kind: 'marker' as const,
          label: formatDayMarker(group.dayKey, now, 'erledigt'),
        },
        ...group.tasks.map((task) => ({ id: task.id, kind: 'flat' as const, task })),
      ]);
      return { rows: flatRows, undatedOpenCount: 0, hasFutureGroup: false };
    }

    const visible = visibleTaskNodes(nodes, hideCompleted);

    if (view === 'alle') {
      return { rows: visible.flatMap(nodeRows), undatedOpenCount: 0, hasFutureGroup: false };
    }

    // view === 'woche'
    const now = new Date();
    const groups = groupByDueDay(weekWindowNodes(visible, now), now);
    const today = localDayKey(now);
    return {
      rows: groups.flatMap((group) => [
        {
          id: `marker:${group.dayKey}`,
          kind: 'marker' as const,
          label: formatDayMarker(group.dayKey, now, 'woche'),
        },
        ...group.nodes.flatMap(nodeRows),
      ]),
      undatedOpenCount: nodes.filter(
        (node) => node.task.dueAt === null && node.task.completedAt === null,
      ).length,
      hasFutureGroup: groups.some((group) => group.dayKey !== 'overdue' && group.dayKey > today),
    };
  }, [dueTodayOnly, tasks, allTasks, nodes, hideCompleted, view]);
  const { rows, undatedOpenCount, hasFutureGroup } = viewModel;
  const presenceRows = useListPresence(rows, (row) => row.id, dueTodayOnly ? undefined : view);

  /**
   * The live drop preview (issue #451), derived through the *same*
   * `resolveNestTarget` the drop itself uses — that is what makes holding over a
   * subtask highlight its parent rather than the subtask, and what keeps a drop
   * that would change nothing (back where it started, or a top-level row over
   * empty space) from showing a promise it will not keep.
   */
  const draggedTask = dragPreview
    ? (allTasks?.find((task) => task.id === dragPreview.draggedId) ?? null)
    : null;
  const previewParentId = dragPreview
    ? resolveNestTarget(dragPreview.draggedId, dragPreview.targetId, allTasks ?? [])
    : null;
  const previewChangesSomething = draggedTask !== null && draggedTask.parentId !== previewParentId;
  const nestTargetId = previewChangesSomething ? previewParentId : null;
  const unnestingId = previewChangesSomething && previewParentId === null ? draggedTask.id : null;
  const previewParentTitle = nestTargetId
    ? (allTasks?.find((task) => task.id === nestTargetId)?.title ?? null)
    : null;
  const dropHint =
    draggedTask === null
      ? null
      : previewParentTitle !== null
        ? `„${draggedTask.title}" wird Unteraufgabe von „${previewParentTitle}"`
        : unnestingId !== null
          ? `„${draggedTask.title}" wird keiner Aufgabe zugeordnet`
          : null;

  function toggleExpanded(taskId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }

  /**
   * Drag-to-nest drop (issue #89) — the primary path, the editor's "Unteraufgabe
   * von" field is the deterministic second one. `resolveNestTarget` encodes the
   * one-level rule (dropping on a child attaches to *its* parent); a no-op drop
   * (dropped back where it already was) skips the mutation entirely.
   */
  async function handleNest(draggedId: string, dropTargetId: string | null) {
    const dragged = allTasks?.find((task) => task.id === draggedId);
    const parentId = resolveNestTarget(draggedId, dropTargetId, allTasks ?? []);
    if (!dragged || dragged.parentId === parentId) return;
    await mutate({ table: 'tasks', rowId: draggedId, op: 'upsert', payload: { parentId } });
  }

  // "Woche"/"Erledigt" (issue #705) have no running-history anchor to speak
  // of — only "Alle" is still the old #88 flat run. `dueTodayOnly` has no
  // switcher and keeps its old, `view`-independent behaviour.
  const anchorActive = dueTodayOnly ? anchorOnMount : anchorOnMount && view === 'alle';

  // Resets the latch on the way *out* of an anchor-eligible view/mount, so the
  // effect below fires again on the way back *in* — "Alle" must re-anchor every
  // time it's entered, not just on the component's first-ever mount (issue #705).
  useEffect(() => {
    if (!anchorActive) anchoredRef.current = false;
  }, [anchorActive]);

  /**
   * Chat-style scroll anchor (issue #88): on open, land on the oldest open task
   * instead of the very top of the history. Runs once per entry into an
   * anchor-eligible view, on the first render that actually has tasks —
   * re-anchoring on every list change (e.g. completing a task) would fight the
   * user's own scrolling.
   *
   * `scrollIntoView` alone gets both halves of the AC for free: the browser
   * clamps to the max scroll position, so a short list (or an anchor near the
   * bottom) never overscrolls into blank space — it just settles as far as real
   * content allows, which for a list that fits the viewport is no scroll at all.
   */
  useEffect(() => {
    if (!anchorActive || anchoredRef.current || tasks === undefined) return;
    const anchorTask = tasks.find((task) => task.completedAt === null);
    const anchorEl = anchorTask
      ? listRef.current?.querySelector<HTMLElement>(`[data-task-id="${anchorTask.id}"]`)
      : null;
    // `useListPresence` (issue #430) seeds its `entries` state via its own effect,
    // one render behind `rows` — the real `<ul>` isn't painted yet on the render
    // where `tasks` first has content. Retry (via the `presenceRows.length`
    // dependency below) instead of marking anchored against an empty list.
    if (anchorTask && !anchorEl) return;
    anchoredRef.current = true;
    anchorEl?.scrollIntoView({ block: 'start' });
  }, [anchorActive, tasks, presenceRows.length]);

  /**
   * Which whole-list message (if any) replaces the `<ul>` (issue #705 AK9's
   * "unverändert" empty state, plus the new "Erledigt" one). Keyed off
   * `allTasks`/`tasks`, never off `rows` — a "Woche" window with nothing due
   * this week is not the same thing as an app with no tasks at all; that case
   * instead renders an empty `<ul>` plus the AK6/AK9 summary lines below it.
   */
  const emptyMessage =
    tasks === undefined
      ? null
      : dueTodayOnly
        ? presenceRows.length === 0
          ? 'Nichts fällig. Genieß den Tag.'
          : null
        : tasks.length === 0
          ? 'Keine Aufgaben. Genieß die Ruhe.'
          : view === 'erledigt' && rows.length === 0
            ? 'Noch nichts erledigt.'
            : null;

  return (
    <>
      {!online && (
        <OfflineNotice>
          Offline — deine Aufgaben sind lokal gespeichert und werden synchronisiert, sobald du
          wieder online bist.
        </OfflineNotice>
      )}

      {!dueTodayOnly && (
        <div className="task-list__view-switcher">
          <SegmentedControl
            label="Aufgaben-Ansicht"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
        </div>
      )}

      {tasks === undefined ? null : emptyMessage !== null ? (
        <p
          className={
            dueTodayOnly ? 'task-list__empty task-list__empty--compact' : 'task-list__empty'
          }
        >
          {emptyMessage}
        </p>
      ) : (
        <>
          <ul
            ref={listRef}
            className="task-list"
            {...(headingId
              ? { 'aria-labelledby': headingId }
              : { 'aria-label': dueTodayOnly ? 'Fällige Aufgaben' : 'Aufgaben' })}
          >
            {presenceRows.map((row) => {
              const entering = row.status === 'entering';
              const leaving = row.status === 'leaving';
              const shared = { entering, leaving, onAnimationEnd: row.onAnimationEnd };

              if (row.item.kind === 'marker') {
                return (
                  <li
                    key={row.key}
                    role="presentation"
                    className="task-list__day-marker list-motion-item"
                    data-entering={entering}
                    data-leaving={leaving}
                    onAnimationEnd={row.onAnimationEnd}
                  >
                    {row.item.label}
                  </li>
                );
              }

              if (row.item.kind === 'flat') {
                const { task } = row.item;
                return (
                  <TaskItem
                    key={row.key}
                    task={task}
                    onToggle={() => toggleComplete(task)}
                    onEdit={() => setEditingTaskId(task.id)}
                    onDelete={() => deleteTask(task)}
                    {...shared}
                  />
                );
              }

              if (row.item.kind === 'parent') {
                const { node } = row.item;
                return (
                  <TaskItem
                    key={row.key}
                    task={node.task}
                    isParent={node.total > 0}
                    progress={node.total > 0 ? { done: node.done, total: node.total } : undefined}
                    expanded={!collapsed.has(node.task.id)}
                    onToggleExpand={() => toggleExpanded(node.task.id)}
                    onToggle={() => toggleComplete(node.task)}
                    onEdit={() => setEditingTaskId(node.task.id)}
                    onDelete={() => deleteTask(node.task, node.children)}
                    onDropOnTask={(targetId) => handleNest(node.task.id, targetId)}
                    onDragOverTask={(targetId) =>
                      setDragPreview({ draggedId: node.task.id, targetId })
                    }
                    onDragEnd={() => setDragPreview(null)}
                    isNestTarget={node.task.id === nestTargetId}
                    isUnnestPreview={node.task.id === unnestingId}
                    {...shared}
                  />
                );
              }

              const { node, child } = row.item;
              return (
                <TaskItem
                  key={row.key}
                  task={child}
                  isChild
                  visible={!collapsed.has(node.task.id)}
                  onToggle={() => toggleComplete(child)}
                  onEdit={() => setEditingTaskId(child.id)}
                  onDelete={() => deleteTask(child)}
                  onDropOnTask={(targetId) => handleNest(child.id, targetId)}
                  onDragOverTask={(targetId) => setDragPreview({ draggedId: child.id, targetId })}
                  onDragEnd={() => setDragPreview(null)}
                  isNestTarget={child.id === nestTargetId}
                  isUnnestPreview={child.id === unnestingId}
                  {...shared}
                />
              );
            })}
          </ul>
          {view === 'woche' && !hasFutureGroup && (
            <p className="task-list__sparse-note">Danach nichts mehr geplant.</p>
          )}
          {view === 'woche' && undatedOpenCount > 0 && (
            <p className="task-list__undated-note">
              {undatedOpenCount} Aufgabe{undatedOpenCount === 1 ? '' : 'n'} ohne Datum
            </p>
          )}
        </>
      )}

      {/* Names the pending drop in words while a row is held (issue #451) — the
          highlighted row alone says *where*, not *what*. role="status" is polite,
          and the text only changes when the resolved target does, so it is not a
          per-pixel announcement. */}
      {dropHint && (
        <p role="status" data-testid="task-drop-hint" className="task-list__drop-hint">
          {dropHint}
        </p>
      )}

      <TaskEditor
        task={editingTask}
        onClose={() => setEditingTaskId(null)}
        nestCandidates={nestCandidates}
        hasChildren={(editingNode?.total ?? 0) > 0}
      />

      {/* Only one undo action is ever in flight — completing and deleting are
          separate gestures a user cannot trigger in the same instant. */}
      {deleteUndo ? (
        <Toast
          message={
            deleteUndo.childIds.length > 0
              ? `„${deleteUndo.title}" + ${deleteUndo.childIds.length} Unteraufgabe${deleteUndo.childIds.length === 1 ? '' : 'n'} gelöscht`
              : `„${deleteUndo.title}" gelöscht`
          }
          actionLabel="Rückgängig"
          onAction={handleDeleteUndo}
          onDismiss={dismissDeleteUndo}
        />
      ) : (
        completeUndo && (
          <Toast
            message={`„${completeUndo.title}" erledigt`}
            actionLabel="Rückgängig"
            onAction={handleCompleteUndo}
            onDismiss={dismissCompleteUndo}
          />
        )
      )}
    </>
  );
}
