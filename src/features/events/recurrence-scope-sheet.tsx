'use client';

import { useRef } from 'react';
import { Sheet } from '@/ui/sheet';

export type RecurrenceScope = 'this' | 'following' | 'series';

export interface RecurrenceScopeOption {
  scope: RecurrenceScope;
  label: string;
}

export interface RecurrenceScopeSheetProps {
  /** `null` closes the sheet. */
  question: string | null;
  options: RecurrenceScopeOption[];
  onChoose: (scope: RecurrenceScope) => void;
  onClose: () => void;
}

/**
 * "Nur dieser" / "Alle folgenden" / "Ganze Serie" (issue #557, S6) — asked
 * whenever an edit or delete targets one occurrence of a recurring series.
 * `options` omits "Nur dieser" when the pending change cannot be represented
 * as an `event_exceptions` override (only start/end and `cancelled` — never
 * `title`/`category`, schema.ts's `eventExceptions` doc comment); that
 * decision lives in the caller, not here.
 */
export function RecurrenceScopeSheet({
  question,
  options,
  onChoose,
  onClose,
}: RecurrenceScopeSheetProps) {
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const open = question !== null;

  return (
    <Sheet open={open} onClose={onClose} label={question ?? ''} initialFocusRef={firstOptionRef}>
      <div className="recurrence-scope-sheet">
        <p className="recurrence-scope-sheet__question">{question}</p>
        <div className="recurrence-scope-sheet__options">
          {options.map((option, index) => (
            <button
              key={option.scope}
              ref={index === 0 ? firstOptionRef : undefined}
              type="button"
              className="recurrence-scope-sheet__option"
              onClick={() => onChoose(option.scope)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className="recurrence-scope-sheet__cancel" onClick={onClose}>
          Abbrechen
        </button>
      </div>
    </Sheet>
  );
}
