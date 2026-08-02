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
