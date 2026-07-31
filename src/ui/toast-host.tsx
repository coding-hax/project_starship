'use client';

import { useSyncExternalStore } from 'react';

/**
 * Module store for the host `<ol>` node, same idiom as
 * `src/features/journal/lock-store.ts` — a plain module variable plus a listener set,
 * not React state, so `<Toast>` (mounted anywhere in the tree) can find the node via
 * `useSyncExternalStore` without a context provider.
 */
let hostNode: HTMLOListElement | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): HTMLOListElement | null {
  return hostNode;
}

function getServerSnapshot(): HTMLOListElement | null {
  return null;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function setToastHostNode(node: HTMLOListElement | null) {
  hostNode = node;
  for (const listener of listeners) listener();
}

export function useToastHostNode(): HTMLOListElement | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Mounted once in the app shell (issue #427). Every `<Toast>` portals into this `<ol>`,
 * so two toasts fired at once stack instead of overlapping, and there is exactly one
 * `aria-live` region for all of them — the toasts themselves keep their own
 * `role="status"`/`"alert"` (docs/DESIGN_SYSTEM.md "Zustände").
 */
export function ToastHost() {
  return (
    <ol
      className="toast-host"
      ref={setToastHostNode}
      aria-live="polite"
      aria-atomic="false"
      role="region"
      aria-label="Benachrichtigungen"
    />
  );
}
