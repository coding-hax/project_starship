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
export function Sheet({ open, onClose, label, initialFocusRef, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Captured right before `showModal()` steals focus, so it survives the whole
  // time the sheet is open and is still there to restore once it closes.
  const triggerRef = useRef<HTMLElement | null>(null);

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
      <div className="sheet__content">{children}</div>
    </dialog>
  );
}
