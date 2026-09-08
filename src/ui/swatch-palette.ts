/**
 * The ten free-choice colour swatches (issue #658), single source for the
 * category-colours settings panel (`src/features/settings/category-colors-panel.tsx`,
 * issue #660): the four area colours already audited for contrast and dark mode,
 * plus `--area-activities`, plus five `--swatch-*` tokens reserved for free choice
 * (docs/DESIGN_SYSTEM.md). Order is binding — the consumer renders it as-is.
 * No longer used by the habit editor (issue #1101: routines identify by emoji now).
 */
export const SWATCH_PALETTE: { token: string; label: string }[] = [
  { token: '--area-habits', label: 'Grün' },
  { token: '--area-tasks', label: 'Koralle' },
  { token: '--area-events', label: 'Teal' },
  { token: '--area-journal', label: 'Violett' },
  { token: '--area-activities', label: 'Blau' },
  { token: '--swatch-rose', label: 'Rosé' },
  { token: '--swatch-amber', label: 'Bernstein' },
  { token: '--swatch-lime', label: 'Limette' },
  { token: '--swatch-sky', label: 'Himmelblau' },
  { token: '--swatch-magenta', label: 'Magenta' },
];
