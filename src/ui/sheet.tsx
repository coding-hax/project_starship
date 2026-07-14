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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
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
      onClose={onClose}
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
