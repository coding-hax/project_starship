'use client';

export interface FabProps {
  /** Full accessible name — unchanged by the visible label below (aria-label wins over content). */
  label: string;
  /** Short visible caption next to the icon. */
  text: string;
  onClick: () => void;
}

/**
 * Floating action button (docs/DESIGN_SYSTEM.md): the entry point for a new item,
 * fixed above the bottom nav so it never costs a navigation.
 */
export function Fab({ label, text, onClick }: FabProps) {
  return (
    <button type="button" className="fab" onClick={onClick} aria-label={label}>
      <span aria-hidden="true" className="fab__icon">
        +
      </span>
      <span className="fab__label">{text}</span>
    </button>
  );
}
