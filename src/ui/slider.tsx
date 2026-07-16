'use client';

import type { CSSProperties } from 'react';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  /** Spoken instead of the raw number, e.g. "Mittel" for a 3-step text-scale slider. */
  valueText?: string;
}

/**
 * A thin, styled wrapper around native `<input type="range">` (ADR-0006) — keyboard
 * (arrow keys, Home/End) and drag come for free, so there's no custom drag code here.
 */
export function Slider({ value, min, max, step = 1, onChange, label, valueText }: SliderProps) {
  const percent = ((value - min) / (max - min)) * 100;

  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      onChange={(event) => onChange(Number(event.target.value))}
      style={{ '--slider-percent': `${percent}%` } as CSSProperties}
    />
  );
}
