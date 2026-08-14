'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

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
export function Sheet({ open, onClose, label, initialFocusRef, header, children }: SheetProps) {
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
      <div className="sheet__content">
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
