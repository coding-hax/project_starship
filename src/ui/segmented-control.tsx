'use client';

import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the whole group (each option's name is its label). */
  label: string;
}

/**
 * `role="radiogroup"` of native `<button role="radio">`s (ADR-0006) with a sliding
 * selection indicator. Roving tabindex + arrow-key navigation is the standard
 * radiogroup pattern — Tab reaches only the selected option, arrows move both
 * focus and selection.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedControlProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);

  function selectByIndex(index: number) {
    const wrapped = (index + options.length) % options.length;
    onChange(options[wrapped].value);
    buttonRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectByIndex(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectByIndex(index - 1);
    }
  }

  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      style={{ '--segmented-count': options.length } as CSSProperties}
    >
      <span
        className="segmented__indicator"
        aria-hidden="true"
        style={{ '--segmented-index': Math.max(selectedIndex, 0) } as CSSProperties}
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            buttonRefs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="segmented__option"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
