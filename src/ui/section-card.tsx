'use client';

import { useId, useState } from 'react';

export interface SectionCardProps {
  title?: string;
  children: React.ReactNode;
  /** Renders the title as a toggle that expands/collapses the body. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}

/**
 * A raised card grouping `Row`s under an optional heading (ADR-0006, pattern from
 * `.export`). Collapsing uses a grid-template-rows transition — animatable without
 * `height: auto`, and `inert` keeps the collapsed content out of tab order and out of
 * the accessibility tree while it's still technically in the DOM for the transition.
 */
export function SectionCard({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className="section-card">
      {title &&
        (collapsible ? (
          <button
            type="button"
            className="section-card__header section-card__header--button"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((o) => !o)}
          >
            <h2 className="section-card__title">{title}</h2>
            <span className="section-card__chevron" data-open={open} aria-hidden="true" />
          </button>
        ) : (
          <h2 className="section-card__title">{title}</h2>
        ))}
      <div className="section-card__collapse" data-open={!collapsible || open}>
        <div id={contentId} className="section-card__body" inert={collapsible && !open}>
          {children}
        </div>
      </div>
    </section>
  );
}
