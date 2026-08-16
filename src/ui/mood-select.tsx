'use client';

import './mood-select.css';

const VALUES = Array.from({ length: 10 }, (_, i) => i + 1);

export interface MoodSelectProps {
  value: number | null;
  onChange: (value: number | null) => void;
}

/**
 * Compact native `<select>` replacing the ten-point `MoodScale` in the entry
 * sheet (issue #785) — `MoodScale` itself stays put for the search's mood
 * filter (issue #415). A real `<select>` so keyboard, VoiceOver and the iOS
 * wheel come without extra code.
 */
export function MoodSelect({ value, onChange }: MoodSelectProps) {
  return (
    <select
      className="mood-select"
      aria-label="Stimmung"
      data-state={value === null ? 'empty' : 'set'}
      value={value === null ? '' : String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === '' ? null : Number(raw));
      }}
    >
      <option value="">—</option>
      {VALUES.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
