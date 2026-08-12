'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Wraps `{children}` in `(app)/layout.tsx`, one level ABOVE the router segment —
 * never `template.tsx`, whose wrapper would become the segment's first element
 * and get stolen by the App Router's post-navigation focus (issue #233), breaking
 * the established header/back-link focus order (e.g. `.weather-day__back`).
 *
 * This wrapper persists across navigations (layouts don't remount), so the CSS
 * animation is restarted per path change via a classList toggle + forced reflow
 * (the standard idiom to retrigger a CSS animation on an unchanged element).
 *
 * No reduced-motion guard here: the global rule in tokens.css collapses
 * `animation-duration` to 0.01ms whenever `prefers-reduced-motion` or the in-app
 * `data-reduce-motion` toggle is active, turning this into an instant, pure
 * opacity swap for free (AC2).
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // Every page starts at its own top, never at the scroll position the previous
  // page (or a prior visit of this same page) was left at — including browser
  // Back/Forward (issue #647). The browser's own restoration only covers
  // popstate, fights this rule there, and does nothing for in-app navigation —
  // switching it off once, globally, replaces both with one rule.
  useEffect(() => {
    history.scrollRestoration = 'manual';
  }, []);

  // Runs on every path change, including the first — a route with its own
  // on-mount scroll anchor (e.g. `/aufgaben`, issue #88; `/kalender`) still
  // starts here and then self-corrects in its own later effect, exactly like a
  // fresh direct load of that route. `window.scrollTo` never touches focus
  // (AC6) and defaults to an instant jump (AC7).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove('page-transition--enter');
    void el.offsetWidth;
    el.classList.add('page-transition--enter');
  }, [pathname]);

  return (
    <div ref={ref} className="page-transition">
      {children}
    </div>
  );
}
