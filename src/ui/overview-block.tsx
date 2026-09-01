import Link from 'next/link';
import type { ReactNode } from 'react';

interface OverviewBlockProps {
  /** Module label for screen readers, rendered as a `.visually-hidden` `<h2>`
   * ahead of the block — set only where the sheet shows no visible title for
   * this module (AK3: Wetter, Aufgaben, Aktivitäten). Sections the sheet does
   * give a visible title render their own `OverviewCardHead` inside the card
   * instead and leave this unset. */
  hiddenTitle?: string;
  /** Set when a descendant needs `aria-labelledby` to point at this heading. */
  headingId?: string;
  children: ReactNode;
}

/**
 * Uniform module wrapper for /uebersicht (issue #972, replaces the #652
 * heading row): the design sheet gives the *card* the title, in the card's own
 * head — not a line on the page ground above it. `OverviewBlock` itself
 * therefore renders no visible heading; `hiddenTitle` covers modules the sheet
 * shows no title for at all (AK3), and `OverviewCardHead` below is what a card
 * puts in its own head where the sheet does show one (AK2).
 */
export function OverviewBlock({ hiddenTitle, headingId, children }: OverviewBlockProps) {
  return (
    <div className="overview-block">
      {hiddenTitle ? (
        <h2 className="visually-hidden" id={headingId}>
          {hiddenTitle}
        </h2>
      ) : null}
      {children}
    </div>
  );
}

interface OverviewCardHeadProps {
  title: string;
  /** Set when a descendant needs `aria-labelledby` to point at this heading. */
  headingId?: string;
  /** Optional muted link on the right (needs both props to render). */
  href?: string;
  moreLabel?: string;
}

/**
 * A card's own head (AK2/AK4): title left, muted link right — same shape as
 * `.section-card__head`, `align-items: flex-start` rather than `baseline`
 * (the aside slot inherits a different font family than the title, and
 * baseline shifts the title under the card edge otherwise, issue #938).
 */
export function OverviewCardHead({ title, headingId, href, moreLabel }: OverviewCardHeadProps) {
  return (
    <div className="overview-block__head">
      <h2 className="overview-block__title" id={headingId}>
        {title}
      </h2>
      {href && moreLabel ? (
        <Link href={href} className="overview-block__more">
          {moreLabel}
        </Link>
      ) : null}
    </div>
  );
}
