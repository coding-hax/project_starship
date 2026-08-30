'use client';

export interface FabProps {
  /** Full accessible name — unchanged by the visible label below (aria-label wins over content). */
  label: string;
  /** Short visible caption next to the icon. */
  text: string;
  onClick: () => void;
  /**
   * Pins `.fab__label` to this width (px) instead of letting it hug `text`
   * (issue #920 CI-Fund, tests/uebersicht-ladezustand.spec.ts AC1, dritte Runde):
   * `.fab` is `position: fixed; right: …; width: auto`, so any font substitution
   * that renders `text` at a different width moves `.fab`'s own box — neither
   * `font-display: block` nor `optional` prevented it, because the mismatch isn't
   * swap *timing*, it's the metric-adjusted fallback face itself: Next's auto
   * fallback is calibrated against a locally installed "Arial", which CI's Linux
   * runner doesn't have, so the substitute it falls through to instead isn't
   * metric-matched at all. A fixed width (plus `overflow: hidden` as a safety
   * clip) makes `.fab`'s box immune to that regardless of which face ends up
   * painting. Opt-in per caller — only the one label long enough to need the
   * margin (`uebersicht-capture.tsx`) sets it, so the other `Fab` call sites
   * keep hugging their own (shorter) text exactly as before.
   */
  reserveLabelWidth?: number;
}

/**
 * Floating action button (docs/DESIGN_SYSTEM.md): the entry point for a new item,
 * fixed above the bottom nav so it never costs a navigation.
 */
export function Fab({ label, text, onClick, reserveLabelWidth }: FabProps) {
  return (
    <button type="button" className="fab" onClick={onClick} aria-label={label}>
      <span aria-hidden="true" className="fab__icon">
        +
      </span>
      <span
        className="fab__label"
        style={
          reserveLabelWidth !== undefined
            ? { width: reserveLabelWidth, overflow: 'hidden' }
            : undefined
        }
      >
        {text}
      </span>
    </button>
  );
}
