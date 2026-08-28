'use client';

import { useId, useState } from 'react';
import { SectionCard } from '@/ui/section-card';
import { SWATCH_PALETTE } from '@/ui/swatch-palette';
import { useCategoryColors, type CategoryColorView } from './use-category-colors';
import './category-colors-panel.css';

interface CategoryColorRowProps {
  view: CategoryColorView;
  /** Other categories currently sharing `view.color` — empty means nothing to show (AC8). */
  sharedWith: string[];
  open: boolean;
  onToggle: () => void;
  onPick: (token: string) => void;
  onReset: () => void;
}

/**
 * One category as a closed-by-default row (issue #858) — tap to reveal its
 * swatch grid. Mirrors `SectionCard`'s collapsible header/body exactly (10px
 * chevron, `grid-template-rows` 0fr/1fr, `inert` while closed) rather than a
 * second pattern, but with its own classes since `SectionCard` itself stays
 * untouched (its collapse is per-card, this one is per-row and mutually
 * exclusive across rows).
 */
function CategoryColorRow({ view, sharedWith, open, onToggle, onPick, onReset }: CategoryColorRowProps) {
  const contentId = useId();
  return (
    <div className="category-colors-panel__category">
      <button
        type="button"
        className="category-colors-panel__row"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="category-colors-panel__row-text">
          <span className="category-colors-panel__row-label">{view.label}</span>
          {sharedWith.length > 0 && (
            <span className="category-colors-panel__row-description">
              Farbe auch bei: {sharedWith.join(', ')}
            </span>
          )}
        </span>
        <span className="category-colors-panel__row-control">
          <span
            className="category-colors-panel__current"
            style={{ background: `var(--cat-${view.category})` }}
            aria-hidden="true"
          />
          <span className="category-colors-panel__chevron" data-open={open} aria-hidden="true" />
        </span>
      </button>
      <div className="category-colors-panel__collapse" data-open={open}>
        <div id={contentId} className="category-colors-panel__body" inert={!open}>
          <fieldset className="category-colors-panel__swatches">
            <legend className="category-colors-panel__legend">Farbe für {view.label}</legend>
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
      </div>
    </div>
  );
}

/**
 * Fünf Kalender-Kategorien als aufklappbare Zeilen (issue #858, ersetzt die
 * fünffach ausgerollte Palette aus #660) — immer höchstens eine Kategorie
 * offen, `openCategory` lebt hier statt je Zeile. Die Vorschau liest
 * `var(--cat-<category>)` direkt (AC2), egal ob Default oder Override: die
 * Auflösung übernimmt das CSS, nie JavaScript (siehe category-colors-boot.tsx).
 */
export function CategoryColorsPanel() {
  const { colors, sharedTokens, setColor, resetColor } = useCategoryColors();
  const [openCategory, setOpenCategory] = useState<string | null>(null);

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
            open={openCategory === view.category}
            onToggle={() =>
              setOpenCategory((current) => (current === view.category ? null : view.category))
            }
            onPick={(token) => setColor(view.category, token)}
            onReset={() => resetColor(view.category)}
          />
        );
      })}
    </SectionCard>
  );
}
