import Link from 'next/link';
import type { ReactNode } from 'react';

interface OverviewBlockProps {
  /** Module label, rendered as the block's own `<h2>`. */
  title: string;
  /** CSS colour value for the heading dot — typically `var(--area-*)`. */
  area: string;
  /** Optional link on the right of the heading row (needs both props to render). */
  href?: string;
  moreLabel?: string;
  /** Set when a descendant needs `aria-labelledby` to point at this heading. */
  headingId?: string;
  children: ReactNode;
}

/**
 * Uniform module head for /uebersicht (issue #652): a heading row on the page
 * ground, deliberately without its own card surface — Termine, Aktivitäten and
 * the (now relocated) Wochenrückblick are already cards, and wrapping those in
 * another one would show more scaffolding than content (R1,
 * docs/design/formwahl-und-zustaende.md).
 */
export function OverviewBlock({ title, area, href, moreLabel, headingId, children }: OverviewBlockProps) {
  return (
    <div className="overview-block">
      <div className="overview-block__heading">
        <h2 className="overview-block__title" id={headingId}>
          <span className="overview-block__dot" style={{ background: area }} aria-hidden="true" />
          {title}
        </h2>
        {href && moreLabel ? (
          <Link href={href} className="overview-block__more">
            {moreLabel}
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}
