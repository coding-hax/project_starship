'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import { OfflineNotice } from '@/ui/offline-notice';
import { useBlockReady } from '@/ui/overview-ready';
import { SectionCard } from '@/ui/section-card';
import { SegmentedControl, type SegmentedOption } from '@/ui/segmented-control';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import {
  completedByDay,
  formatDayMarker,
  groupByDueDay,
  groupTasks,
  localDayKey,
  openTaskNodes,
  resolveNestTarget,
  undatedOpenNodes,
  useTasks,
  weekWindowNodes,
  type TaskNode,
  type TaskView,
} from './use-tasks';

/** The `/aufgaben` view switcher (issue #705 AK2) — ephemeral, never persisted;
 *  a fresh navigation always lands back on `'woche'`. Irrelevant for the
 *  `dueTodayOnly` (/uebersicht) instance, which has no switcher and always
 *  renders the "Woche" shape (issue #762). */
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

/**
 * The "Woche" shape (issue #705 AK3, reused on /uebersicht by issue #762): a day
 * marker above every non-empty bucket, then that bucket's nodes. Shared so
 * /uebersicht's always-"Woche" list and /aufgaben's "Woche" tab cannot drift
 * apart — the only difference between the two call sites is whether the
 * caller also needs `groups` itself (AK9's sparse note, /aufgaben only).
 */
function buildWocheRows(nodesForWindow: TaskNode[], now: Date) {
  const groups = groupByDueDay(weekWindowNodes(nodesForWindow, now), now);
  const rows: TaskRow[] = groups.flatMap((group) => [
    {
      id: `marker:${group.dayKey}`,
      kind: 'marker' as const,
      label: formatDayMarker(group.dayKey, now, 'woche'),
    },
    ...group.nodes.flatMap(nodeRows),
  ]);
  return { rows, groups };
}

export interface TaskListProps {
  /**
   * The /uebersicht dashboard subset (issue #87, issue #228): the same "Woche"
   * shape /aufgaben's "Woche" tab renders (day markers, "Überfällig" first, the
   * 7-day window — issue #762), just without the view switcher. Everything else
   * (editor, offline notice) stays the same so the two lists don't drift apart.
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
  // Grouped from the full list (issue #89) — nesting structure, the /uebersicht
  // week window below (issue #762), and the row-building viewModel further down
  // all need it.
  const nodes = useMemo(() => groupTasks(allTasks ?? []), [allTasks]);
  // `useMemo`'d on `[allTasks, nodes, dueTodayOnly]` — `allTasks` is referentially
  // stable across renders that aren't a real live-query emission (see
  // use-live-table.ts), and `useListPresence` below needs that stability to
  // tell "the data changed" apart from "this component re-rendered for some
  // other reason" (editingTaskId, collapsed, …). On /uebersicht this flattens the
  // week-windowed nodes back out (issue #762) — only the anchor/empty-state below
  // need the flat shape, the viewModel further down re-derives the grouped rows
  // itself.
  const tasks = useMemo(() => {
    if (!dueTodayOnly) return allTasks;
    if (allTasks === undefined) return undefined;
    return weekWindowNodes(nodes, new Date()).flatMap((node) => [node.task, ...node.children]);
  }, [allTasks, nodes, dueTodayOnly]);
  // Inert on /aufgaben, where this list is the whole screen and has nothing below
  // it to push; on /uebersicht it joins the shared reveal point (issue #642).
  useBlockReady(allTasks !== undefined);
  const online = useOnline();
  const { toggleComplete } = useCompleteTask();
  const { deleteTask } = useDeleteTask();
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Ephemeral, not persisted (issue #705 AK2) — a fresh /aufgaben navigation
  // always starts back on "Woche". Unused on the `dueTodayOnly` instance,
  // which never renders the switcher and never changes it away from the default.
  const [view, setView] = useState<ViewMode>('woche');
  // Ephemeral, not persisted (per-ticket decision) — holds the ids the user has
  // expanded, default collapsed on both /aufgaben (issue #781) and /uebersicht
  // (issue #779): a parent row shows its `done/total` and holds its children
  // back until asked. Seeding the set instead (fill it with every parent id on
  // the first tasks arrive) was the more obvious route but breaks on two edges
  // this never opens: `allTasks` is `undefined` on the very first render, and a
  // task arriving later via sync pull would land expanded while everything else
  // stays collapsed.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const isExpanded = (taskId: string) => expandedIds.has(taskId);
  // A task's own id -> parentId as of the last render with real data (issue
  // #781 AK5) — lets the effect below tell "just became a child" apart from
  // "was already one before this component ever mounted". `null` until the
  // first real `allTasks` snapshot exists, so that snapshot itself never reads
  // as a mass of fresh re-parentings.
  const prevParentIdsRef = useRef<Map<string, string | null> | null>(null);
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
  const editingNode = nodes.find((node) => node.task.id === editingTaskId);
  const nestCandidates = nodes
    .filter((node) => node.task.id !== editingTaskId)
    .map((node) => node.task);

  /**
   * `rows` plus what AK6/AK9 need beyond what a flat row list can carry (issue
   * #705) — `undatedNodes` backs the expandable "ohne Datum" card (issue #762),
   * `hasFutureGroup` the AK9 sparse note. `now` is read once per recompute here,
   * not on every render — the grouping only needs to reflect "now" when the
   * underlying data or the view actually changes.
   */
  const viewModel = useMemo(() => {
    if (dueTodayOnly) {
      return {
        rows: buildWocheRows(nodes, new Date()).rows,
        undatedNodes: undatedOpenNodes(nodes),
        hasFutureGroup: false,
      };
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
      return { rows: flatRows, undatedNodes: [], hasFutureGroup: false };
    }

    if (view === 'alle') {
      return { rows: openTaskNodes(nodes).flatMap(nodeRows), undatedNodes: [], hasFutureGroup: false };
    }

    // view === 'woche' — filters completed tasks out via weekWindowNodes itself
    // (AK7's "heute erledigt bleibt" rule), so it takes the full tree, not
    // openTaskNodes's result.
    const now = new Date();
    const { rows, groups } = buildWocheRows(nodes, now);
    const today = localDayKey(now);
    return {
      rows,
      undatedNodes: undatedOpenNodes(nodes),
      hasFutureGroup: groups.some((group) => group.dayKey !== 'overdue' && group.dayKey > today),
    };
  }, [dueTodayOnly, allTasks, nodes, view]);
  const { rows, undatedNodes, hasFutureGroup } = viewModel;
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
    setExpandedIds((prev) => {
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
   * A task re-parented onto a collapsed parent must not go invisible (issue
   * #781 AK5) — covers both drag-to-nest and the editor's "Unteraufgabe von"
   * field, since both just change `parentId` through the same `allTasks` live
   * query and land here either way. Only a task the previous snapshot already
   * knew about counts as "just re-parented" — a brand new task created
   * straight under a parent (`parentId` set at creation) has no previous
   * snapshot to compare against and is excluded on purpose, same as the very
   * first snapshot itself (`prevParentIdsRef.current === null`) is: neither is
   * a parent actually *gaining* a child while the user is looking at the list.
   */
  useEffect(() => {
    if (allTasks === undefined) return;
    const prevParentIds = prevParentIdsRef.current;
    prevParentIdsRef.current = new Map(allTasks.map((task) => [task.id, task.parentId]));
    if (prevParentIds === null) return;
    const newlyNestedParentIds = allTasks
      .filter(
        (task) =>
          task.parentId !== null &&
          prevParentIds.has(task.id) &&
          prevParentIds.get(task.id) !== task.parentId,
      )
      .map((task) => task.parentId as string);
    if (newlyNestedParentIds.length === 0) return;
    setExpandedIds((prev) => new Set([...prev, ...newlyNestedParentIds]));
  }, [allTasks]);

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

  /**
   * One `TaskRow` as JSX — shared by the main list and the "ohne Datum" card
   * below it (issue #762), so the two never render a task differently. Nesting
   * stays off on /uebersicht (`dueTodayOnly`): `TaskItem`'s long-press lift only
   * arms when `onDropOnTask` is passed at all, so omitting the three drag props
   * there disables it outright, same as the old flat /uebersicht rows always did.
   */
  function renderTaskRow(
    row: TaskRow,
    key: string,
    shared: { entering: boolean; leaving: boolean; onAnimationEnd?: () => void },
  ) {
    if (row.kind === 'marker') {
      return (
        <li
          key={key}
          role="presentation"
          className="task-list__day-marker list-motion-item"
          data-entering={shared.entering}
          data-leaving={shared.leaving}
          onAnimationEnd={shared.onAnimationEnd}
        >
          {row.label}
        </li>
      );
    }

    if (row.kind === 'flat') {
      const { task } = row;
      return (
        <TaskItem
          key={key}
          task={task}
          onToggle={() => toggleComplete(task)}
          onEdit={() => setEditingTaskId(task.id)}
          onDelete={() => deleteTask(task)}
          {...shared}
        />
      );
    }

    if (row.kind === 'parent') {
      const { node } = row;
      return (
        <TaskItem
          key={key}
          task={node.task}
          isParent={node.total > 0}
          progress={node.total > 0 ? { done: node.done, total: node.total } : undefined}
          expanded={isExpanded(node.task.id)}
          onToggleExpand={() => toggleExpanded(node.task.id)}
          onToggle={() => toggleComplete(node.task)}
          onEdit={() => setEditingTaskId(node.task.id)}
          onDelete={() => deleteTask(node.task, node.children)}
          onDropOnTask={dueTodayOnly ? undefined : (targetId) => handleNest(node.task.id, targetId)}
          onDragOverTask={
            dueTodayOnly
              ? undefined
              : (targetId) => setDragPreview({ draggedId: node.task.id, targetId })
          }
          onDragEnd={dueTodayOnly ? undefined : () => setDragPreview(null)}
          isNestTarget={node.task.id === nestTargetId}
          isUnnestPreview={node.task.id === unnestingId}
          {...shared}
        />
      );
    }

    const { node, child } = row;
    return (
      <TaskItem
        key={key}
        task={child}
        isChild
        visible={isExpanded(node.task.id)}
        onToggle={() => toggleComplete(child)}
        onEdit={() => setEditingTaskId(child.id)}
        onDelete={() => deleteTask(child)}
        onDropOnTask={dueTodayOnly ? undefined : (targetId) => handleNest(child.id, targetId)}
        onDragOverTask={
          dueTodayOnly ? undefined : (targetId) => setDragPreview({ draggedId: child.id, targetId })
        }
        onDragEnd={dueTodayOnly ? undefined : () => setDragPreview(null)}
        isNestTarget={child.id === nestTargetId}
        isUnnestPreview={child.id === unnestingId}
        {...shared}
      />
    );
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
   * Which whole-list message (if any) replaces the `<ul>` (issue #705). Two
   * different things both read as "empty" here, and they must stay distinct:
   * an account with zero tasks at all (checked via `tasks.length`, never
   * `rows` — a "Woche" window with nothing *due this week* is not that, it
   * renders an empty `<ul>` plus the AK6/AK9 summary lines below it instead),
   * and "Alle"/"Erledigt" with every row gone (issue #814). All three key
   * off `presenceRows` too, not just `tasks`/`rows`: a row that just lost its
   * last sibling — deleted, or filtered out of "Alle" as completed — is still in
   * `presenceRows` mid-exit-animation (`status: 'leaving'`), and swapping the
   * `<ul>` out from under it the instant the underlying data hits zero would
   * cut that animation off before it ever painted (issue #430's guarantee,
   * list-motion.spec.ts AC2).
   */
  const emptyMessage =
    tasks === undefined
      ? null
      : dueTodayOnly
        ? presenceRows.length === 0
          ? 'Nichts fällig. Genieß den Tag.'
          : null
        : tasks.length === 0 && presenceRows.length === 0
          ? 'Keine Aufgaben. Genieß die Ruhe.'
          : view === 'alle' && presenceRows.length === 0
            ? 'Keine Aufgaben. Genieß die Ruhe.'
            : view === 'erledigt' && presenceRows.length === 0
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
              : { 'aria-label': dueTodayOnly ? 'Aufgaben der Woche' : 'Aufgaben' })}
          >
            {presenceRows.map((row) =>
              renderTaskRow(row.item, row.key, {
                entering: row.status === 'entering',
                leaving: row.status === 'leaving',
                onAnimationEnd: row.onAnimationEnd,
              }),
            )}
          </ul>
          {/* AK9's "nothing left this week" (issue #705) — /uebersicht (`dueTodayOnly`)
              has no page of its own below the list to make this note meaningful on, so
              it stays an /aufgaben-only line, same as before issue #762. */}
          {!dueTodayOnly && view === 'woche' && !hasFutureGroup && (
            <p className="task-list__sparse-note">Danach nichts mehr geplant.</p>
          )}
        </>
      )}

      {/* AK6's "ohne Datum" card (issue #705), an expandable `SectionCard` instead of
          the old plain note since issue #762 — undated tasks never match
          `weekWindowNodes`'s parent-driven window, so this is the only place either
          "Woche" view (/uebersicht, always; /aufgaben's "Woche" tab) surfaces them,
          same collapsed-by-default pattern as "Archiviert" (habit-list.tsx). Sits
          outside the empty/list ternary above on purpose — a week with nothing due
          still needs to reveal this card if something is undated, so it cannot hide
          behind that message (which only speaks to the *dated* rows). */}
      {tasks !== undefined && (dueTodayOnly || view === 'woche') && undatedNodes.length > 0 && (
        <SectionCard
          title={`${undatedNodes.length} Aufgabe${undatedNodes.length === 1 ? '' : 'n'} ohne Datum`}
          collapsible
          defaultOpen={false}
          className="task-list__undated-card"
        >
          {/* Not "Aufgaben ohne Datum" — `getByRole('list', { name: 'Aufgaben' })`
              (tasks.spec.ts, uebersicht.spec.ts) matches by substring, so a label
              containing "Aufgaben" would fold this collapsed list's rows into the
              main list's count from every consumer of that locator. */}
          <ul className="task-list" aria-label="Ohne Datum">
            {undatedNodes
              .flatMap(nodeRows)
              .map((item) => renderTaskRow(item, item.id, { entering: false, leaving: false }))}
          </ul>
        </SectionCard>
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
        state={editingTask ? { mode: 'edit', task: editingTask } : null}
        onClose={() => setEditingTaskId(null)}
        nestCandidates={nestCandidates}
        hasChildren={(editingNode?.total ?? 0) > 0}
      />
    </>
  );
}
