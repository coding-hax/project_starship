'use client';

import { useSyncExternalStore } from 'react';

export type JournalFilterChip = 'mood' | 'tag' | 'range';

export interface JournalSearchStateValue {
  query: string;
  mood: number | null;
  tag: string | null;
  from: string;
  to: string;
  openChip: JournalFilterChip | null;
}

const INITIAL_STATE: JournalSearchStateValue = {
  query: '',
  mood: null,
  tag: null,
  from: '',
  to: '',
  openChip: null,
};

let state: JournalSearchStateValue = INITIAL_STATE;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot() {
  return state;
}

/** Same reasoning as journal-view-mode.ts's getServerSnapshot: the server
 * never has a search query or an open filter chip. */
function getServerSnapshot() {
  return INITIAL_STATE;
}

/**
 * Shared module store (same pattern as journal-view-mode.ts) for the search
 * query and its three filters (issue #1051): the pill lives in the page's
 * eyebrow slot, the chips in its extra slot, and the open filter panel plus
 * the results stay in the editor tree below the gate — three different
 * subtrees that all need to read and change the same state.
 */
export function useJournalSearchState(): JournalSearchStateValue {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setSearchQuery(query: string) {
  state = { ...state, query };
  notify();
}

export function setMoodFilter(mood: number | null) {
  state = { ...state, mood };
  notify();
}

export function setTagFilter(tag: string | null) {
  state = { ...state, tag };
  notify();
}

export function setRangeFilter(from: string, to: string) {
  state = { ...state, from, to };
  notify();
}

/** A chip toggles its own panel; opening one closes whichever other was open
 * — only one filter's controls show at a time (issue #1051 AK2). */
export function toggleFilterChip(chip: JournalFilterChip) {
  state = { ...state, openChip: state.openChip === chip ? null : chip };
  notify();
}

/** Leaving search mode (Abbrechen, a result click, or the journal locking)
 * resets query, filters and the open chip — a later reopen starts clean,
 * same contract the previous local component state gave AC-P4/#847 AK4. */
export function resetJournalSearch() {
  state = INITIAL_STATE;
  notify();
}
