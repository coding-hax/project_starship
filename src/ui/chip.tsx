'use client';

import { IconClose } from './icons';

export interface ChipProps {
  /** Field name, spoken before the value by a screen reader (issue #711 AK6) and
   * used to build the discard button's label ("`${field} verwerfen`"). */
  field: string;
  /** Shown — and read out alone — while `value` is empty, e.g. "Wann?". */
  emptyLabel: string;
  value?: string | null;
  /** A guessed value counts as accepted: doing nothing keeps it (AK2). Only the
   * discard button (rendered when this is true) throws it away; the chip body
   * still opens the picker like any other set chip. */
  guessed?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpen: () => void;
  onDiscard?: () => void;
  /** id of the panel this chip's body controls (`aria-controls`) — the panel
   * itself only exists in the DOM while `open` is true. */
  panelId: string;
  /** issue #716 AK5: this field was just overwritten by the latest Übernahme —
   * purely visual (a status line spells the change out in words for screen
   * readers, so this never touches `aria-label`). */
  changed?: boolean;
}

/**
 * Five states = f(value, guessed, disabled, open) (issue #711 AK1). Not a single
 * button: the guessed state's discard target (`chip__discard`, the "x") sits next
 * to `chip__body` rather than inside it — nesting a button in a button is invalid
 * HTML, and the two need independent hit areas (AK2's confirmed resolution: the
 * body keeps opening the picker, only the "x" discards).
 */
export function Chip({
  field,
  emptyLabel,
  value = null,
  guessed = false,
  disabled = false,
  open = false,
  onOpen,
  onDiscard,
  panelId,
  changed = false,
}: ChipProps) {
  const state = disabled ? 'disabled' : guessed ? 'guessed' : value ? 'set' : 'empty';
  const label = value ? `${field}, ${value}` : field;
  const showDiscard = guessed && !disabled && Boolean(onDiscard);

  return (
    <div className="chip" data-state={state} data-open={open} data-changed={changed}>
      <button
        type="button"
        className={showDiscard ? 'chip__body chip__body--with-discard' : 'chip__body'}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={onOpen}
      >
        {value ?? emptyLabel}
      </button>
      {showDiscard && (
        <button
          type="button"
          className="chip__discard"
          aria-label={`${field} verwerfen`}
          onClick={onDiscard}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}
