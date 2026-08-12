'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { SWATCH_PALETTE } from '@/ui/swatch-palette';
import { useCategoryColors, type CategoryColorView } from './use-category-colors';
import './category-colors-panel.css';

interface CategoryColorRowProps {
  view: CategoryColorView;
  /** Other categories currently sharing `view.color` — empty means nothing to show (AC8). */
  sharedWith: string[];
  onPick: (token: string) => void;
  onReset: () => void;
}

/**
 * One category's swatch grid (issue #660, layout mirrors habit-editor.tsx's
 * `.habit-editor__colors`). Unlike the habit editor, none of the ten swatches
 * doubles as "no override" — the category default (AC5) is the existing
 * `--cat-<category>` token, which is not itself one of the ten — so resetting
 * is its own action, only offered once an override is stored.
 */
function CategoryColorRow({ view, sharedWith, onPick, onReset }: CategoryColorRowProps) {
  return (
    <div className="category-colors-panel__category">
      <Row
        label={view.label}
        description={sharedWith.length > 0 ? `Farbe auch bei: ${sharedWith.join(', ')}` : undefined}
      >
        <span
          className="category-colors-panel__current"
          style={{ background: `var(--cat-${view.category})` }}
          aria-hidden="true"
        />
      </Row>
      <fieldset className="category-colors-panel__swatches">
        <legend>Farbe</legend>
        {SWATCH_PALETTE.map((swatch) => (
          <label key={swatch.token} className="category-colors-panel__swatch-option">
            <input
              type="radio"
              name={`category-color-${view.category}`}
              aria-label={`${view.label}: ${swatch.label}`}
              checked={view.color === swatch.token}
              onChange={() => onPick(swatch.token)}
            />
            <span
              className="category-colors-panel__swatch"
              style={{ background: `var(${swatch.token})` }}
              aria-hidden="true"
            />
          </label>
        ))}
      </fieldset>
      {view.persisted && (
        <button
          type="button"
          className="category-colors-panel__reset"
          onClick={onReset}
          aria-label={`${view.label}: Standardfarbe verwenden`}
        >
          Standard verwenden
        </button>
      )}
    </div>
  );
}

/**
 * Fünf Kalender-Kategorien, je eine Zehnerpalette (issue #660) — Vorbild
 * habit-editor.tsx (issue #658). Die Vorschau liest `var(--cat-<category>)`
 * direkt (AC2), egal ob Default oder Override: die Auflösung übernimmt das
 * CSS, nie JavaScript (siehe category-colors-boot.tsx).
 */
export function CategoryColorsPanel() {
  const { colors, sharedTokens, setColor, resetColor } = useCategoryColors();

  return (
    <SectionCard title="Kategoriefarben">
      {colors?.map((view) => {
        const sharedWith =
          view.color && sharedTokens.has(view.color)
            ? colors
                .filter((candidate) => candidate.category !== view.category && candidate.color === view.color)
                .map((candidate) => candidate.label)
            : [];
        return (
          <CategoryColorRow
            key={view.category}
            view={view}
            sharedWith={sharedWith}
            onPick={(token) => setColor(view.category, token)}
            onReset={() => resetColor(view.category)}
          />
        );
      })}
    </SectionCard>
  );
}
