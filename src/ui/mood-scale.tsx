'use client';

import './mood-scale.css';

const VALUES = Array.from({ length: 10 }, (_, i) => i + 1);

export interface MoodScaleProps {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Overrides each point's accessible name (default: the bare number).
   * Needed when a second MoodScale is visible on the same page at once
   * (issue #415 mood filter next to the editor's own scale) — otherwise
   * both points share the name "5" and role queries become ambiguous. */
  ariaLabelForValue?: (n: number) => string;
}

/**
 * Ten one-tap points, 1–10 (issue #340 AC1). A tap sets the value; tapping the
 * already-set point clears it — a mood is never mandatory. The number sits on
 * the point itself (design brief: meaning must not hang on colour alone).
 */
export function MoodScale({ value, onChange, ariaLabelForValue }: MoodScaleProps) {
  return (
    <div className="mood-scale" role="group" aria-label="Stimmung, 1 bis 10">
      {VALUES.map((n) => (
        <button
          key={n}
          type="button"
          className="mood-scale__point spring-press"
          aria-pressed={value === n}
          aria-label={ariaLabelForValue?.(n)}
          onClick={() => onChange(value === n ? null : n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
