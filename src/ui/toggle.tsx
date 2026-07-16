'use client';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name — Toggle has no visible label of its own (Row provides one). */
  label: string;
}

/**
 * A switch built on a native `<button>` (ADR-0006): `role="switch"` plus
 * `aria-checked` carries the state, so Space/Enter and focus come for free and
 * the state is never conveyed by motion alone.
 */
export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      data-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  );
}
