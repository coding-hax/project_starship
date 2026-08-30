'use client';

import { useId, useState } from 'react';

export interface SectionCardProps {
  title?: string;
  children: React.ReactNode;
  /** Renders the title as a toggle that expands/collapses the body. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Extra class on the root `.section-card`, for callers that need to override
   * spacing (e.g. denser padding) without reaching into this component's own
   * class from the outside (issue #288). */
  className?: string;
  /** Content in the header's end slot, next to the title — e.g. a "Gefühlt 21°"
   * readout (issue #927) or a precipitation total (issue #938). Only rendered on
   * the non-collapsible path — the collapsible header is already a button with
   * its own chevron, a second slot there is out of scope. */
  headerAside?: React.ReactNode;
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
  className,
  headerAside,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className={className ? `section-card ${className}` : 'section-card'}>
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
        ) : headerAside ? (
          <div className="section-card__head">
            <h2 className="section-card__title">{title}</h2>
            <div className="section-card__aside">{headerAside}</div>
          </div>
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
