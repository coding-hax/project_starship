'use client';

export interface FabProps {
  label: string;
  onClick: () => void;
}

/**
 * Floating action button (docs/DESIGN_SYSTEM.md): the entry point for a new item,
 * fixed above the bottom nav so it never costs a navigation.
 */
export function Fab({ label, onClick }: FabProps) {
  return (
    <button type="button" className="fab" onClick={onClick} aria-label={label}>
      <span aria-hidden="true" className="fab__icon">
        +
      </span>
    </button>
  );
}
