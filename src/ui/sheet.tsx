'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

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
  children: ReactNode;
}

/**
 * A reusable bottom sheet built on `<dialog>`: native focus trap, ESC-to-close and a
 * backdrop come for free, so this needs no extra dependency (CLAUDE.md rule 3).
 */
export function Sheet({ open, onClose, label, initialFocusRef, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Captured right before `showModal()` steals focus, so it survives the whole
  // time the sheet is open and is still there to restore once it closes.
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      const trigger = document.activeElement as HTMLElement | null;
      triggerRef.current = trigger;
      // `inert` alone doesn't keep a same-named trigger (e.g. a FAB and the
      // sheet's own submit button, #701) from being a second match for
      // Playwright's `getByRole` — confirmed against a real run: the trigger
      // still resolved with `inert=""` present. `aria-hidden` is what
      // `getByRole`'s accessible-name computation actually excludes on, so
      // it does the disambiguating; `inert` stays alongside it to also drop
      // real keyboard/pointer interaction with the trigger while it's
      // visually behind the modal backdrop. Guard against `body`: that's what
      // `activeElement` falls back to when nothing has focus, and hiding it
      // would take the whole document — the dialog included — off the tree.
      if (trigger && trigger !== document.body) {
        trigger.inert = true;
        trigger.setAttribute('aria-hidden', 'true');
      }
      dialog.showModal();
      initialFocusRef?.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocusRef]);

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
          triggerRef.current.inert = false;
          triggerRef.current.removeAttribute('aria-hidden');
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
      <div className="sheet__content">{children}</div>
    </dialog>
  );
}
