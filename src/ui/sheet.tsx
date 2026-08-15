'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

export interface SheetHeaderProps {
  /** Label of the action button on the right (e.g. "Anlegen", "Sichern", "Eintragen"). */
  actionLabel: string;
  /** id of the `<form>` inside `children` the action button submits — it lives
   * outside that form (in the header row), so the HTML `form` attribute is what
   * associates the two. */
  formId: string;
  /** Disables the action button (e.g. an empty form, issue #714) without hiding
   * it — it stays in place, just visually faint and inert. */
  disabled?: boolean;
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  label: string;
  /**
   * Focused once the sheet has opened. `showModal()`'s own autofocus algorithm looks
   * for an `autofocus` *attribute*, but React applies `autoFocus` by calling `.focus()`
   * once on mount — which already happened long before the sheet re-opens. Doing it
   * explicitly here is what actually gets the cursor into the field.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Opts into the shared header (issue #710): grip, "Abbrechen" left, `label`
   * centered, action button right. Left out entirely by sheets that ask their own
   * question instead of hosting a form (e.g. `RecurrenceScopeSheet`).
   */
  header?: SheetHeaderProps;
  /**
   * Overrides `--accent` (and everything that reads from it — chips, the header
   * action button, focus rings) on `.sheet__content` for this one sheet, e.g. a
   * capture sheet whose accent follows the recognized art (issue #715 AK2). Left
   * out entirely, `.sheet__content` just inherits the page's own `--accent`.
   */
  accent?: string;
  children: ReactNode;
}

/** Ignore jitter before committing to a pull — mirrors task-item.tsx's
 * TAP_TOLERANCE_PX, otherwise a tap on the grip/header would read as a drag. */
const DRAG_TOLERANCE_PX = 8;
/** How far down counts as "let go of this" rather than "just browsing" (issue #757). */
const DISMISS_THRESHOLD_PX = 120;

/** A selection made before the pull would otherwise stay highlighted underneath
 * it (same fix as task-item.tsx's clearTextSelection, issue #451). */
function clearTextSelection() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

/**
 * A reusable bottom sheet built on `<dialog>`: native focus trap, ESC-to-close and a
 * backdrop come for free, so this needs no extra dependency (CLAUDE.md rule 3).
 *
 * Deliberately does NOT touch the trigger element's DOM state (`inert`/`aria-hidden`)
 * while open: this component is shared across features (journal's FAB, tasks'
 * quick-add, habit editors, …), and `tests/design-system.spec.ts`'s z-scale AC3
 * relies on the trigger staying normally queryable — just visually covered by the
 * modal backdrop — while its own sheet is open. A trigger whose accessible name
 * collides with something inside its own sheet (journal's FAB/submit button both
 * "Eintragen", #701) is that one consumer's problem to disambiguate, e.g. by
 * scoping test locators to a CSS class instead of relying on this component to
 * hide the trigger for everyone.
 */
export function Sheet({ open, onClose, label, initialFocusRef, header, accent, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Captured right before `showModal()` steals focus, so it survives the whole
  // time the sheet is open and is still there to restore once it closes.
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; scrollTop: number } | null>(null);
  // Read from the native `touchmove` listener below, which is attached once on
  // mount and would otherwise close over a stale `false` forever (same reason
  // task-item.tsx keeps a `liftedRef` next to its `lifted` state).
  const draggingRef = useRef(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      initialFocusRef?.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocusRef]);

  /**
   * Blocks the browser's own scroll/rubber-band on `.sheet__content` (which is
   * itself the scrollable element) once a pull has committed — `preventDefault()`
   * inside a React `onPointerMove`/`onTouchMove` prop doesn't reliably cancel the
   * native touch scroll it rides on, so this needs the same natively-registered,
   * non-passive listener task-item.tsx uses for its own vertical (lifted) drag.
   */
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    function blockScrollWhileDragging(event: TouchEvent) {
      if (draggingRef.current) event.preventDefault();
    }
    el.addEventListener('touchmove', blockScrollWhileDragging, { passive: false });
    return () => el.removeEventListener('touchmove', blockScrollWhileDragging);
  }, []);

  function setDraggingState(next: boolean) {
    draggingRef.current = next;
    setDragging(next);
  }

  /**
   * Pulling the sheet down (issue #757). Starts tracking on any non-interactive
   * part of the card — form controls (inputs, buttons, …) keep their normal
   * click/focus/selection behaviour untouched, only actual downward movement
   * past `DRAG_TOLERANCE_PX` turns this into a drag (see `handlePointerMove`).
   */
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Left untouched, not just excluded from starting a drag: a `preventDefault()`
    // here would also suppress the synthesized click a touch pointer relies on —
    // breaking e.g. a `<label>` wrapping a `Toggle` elsewhere in a sheet's form.
    if ((event.target as HTMLElement).closest('input, textarea, select, button, a, label, [contenteditable]')) {
      return;
    }
    clearTextSelection();
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollTop: contentRef.current?.scrollTop ?? 0,
    };
  }

  /**
   * The gesture only "wins" once it is clearly vertical, downward, past the
   * tolerance, *and* the content had nothing above it left to scroll into at the
   * start — otherwise this would fight normal scrolling inside a tall sheet
   * (e.g. the journal editor).
   */
  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (!start) return;
    const deltaY = event.clientY - start.y;
    const deltaX = event.clientX - start.x;

    if (!draggingRef.current) {
      if (deltaY <= DRAG_TOLERANCE_PX || deltaY <= Math.abs(deltaX) || start.scrollTop > 0) return;
      setDraggingState(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    event.preventDefault();
    setDragY(Math.max(0, deltaY));
  }

  /** Past the threshold, closing goes through the same `dialog.close()` every
   * other dismiss path already uses (see the `onClose` prop below) — one path
   * in, focus returns to the trigger exactly like ESC/backdrop/Abbrechen. */
  function commitOrSnapBack(event: ReactPointerEvent<HTMLDivElement>) {
    if (draggingRef.current) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (dragY > DISMISS_THRESHOLD_PX) {
        ref.current?.close();
      }
      setDragY(0);
    }
    dragStartRef.current = null;
    setDraggingState(false);
  }

  /** A cancelled gesture (e.g. the browser takes over) never dismisses — only
   * snaps back, same as letting go short of the threshold. */
  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (draggingRef.current) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragY(0);
    }
    dragStartRef.current = null;
    setDraggingState(false);
  }

  const contentStyle: CSSProperties = accent ? ({ '--accent': accent } as CSSProperties) : {};
  if (dragY > 0) contentStyle.transform = `translateY(${dragY}px)`;

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onClose={() => {
        onClose();
        // Fires for all three close paths (action, ESC, backdrop) — one place
        // returns focus regardless of how the sheet was dismissed.
        if (triggerRef.current && document.contains(triggerRef.current)) {
          triggerRef.current.focus();
        }
      }}
      onCancel={onClose}
      onClick={(event) => {
        // The dialog element is sized to the full viewport (see sheet.css) — a click
        // that lands on it rather than on .sheet__content is a backdrop click.
        if (event.target === ref.current) onClose();
      }}
    >
      <div
        ref={contentRef}
        className={dragging ? 'sheet__content sheet__content--dragging' : 'sheet__content'}
        style={contentStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitOrSnapBack}
        onPointerCancel={cancelDrag}
      >
        {header && (
          <div className="sheet__header">
            <div className="sheet__grip" aria-hidden="true" />
            <div className="sheet__header-row">
              {/* Same `onClose` prop the backdrop click already calls (see `onClick`
                  below) — one path into `dialog.close()`, so focus returns to the
                  trigger exactly like ESC and the backdrop already do (AK4). */}
              <button type="button" className="sheet__cancel" onClick={onClose}>
                Abbrechen
              </button>
              <p className="sheet__title">{label}</p>
              <button
                type="submit"
                form={header.formId}
                className="sheet__action"
                disabled={header.disabled}
              >
                {header.actionLabel}
              </button>
            </div>
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}
