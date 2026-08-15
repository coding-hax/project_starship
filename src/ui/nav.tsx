'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useModules } from '@/features/settings/use-modules';
import { useNavOrder } from '@/features/settings/use-nav-order';

/**
 * One navigation, two shapes: bottom bar on mobile, sidebar from `md` up.
 * Not a second design — the same links, laid out differently (DESIGN_SYSTEM.md).
 * Mobile is a horizontal carousel past five entries (issue #205); the order comes
 * from `useNavOrder`, so a change in Einstellungen shows here immediately.
 *
 * Einstellungen is not a tab here — its entry point lives in AppHeader instead.
 */
export function Nav() {
  const pathname = usePathname();
  const { items } = useNavOrder();
  const { isActive } = useModules();
  const visibleItems = items.filter((item) => isActive(item.id));
  const listRef = useRef<HTMLUListElement>(null);

  // Scrolls the current tab into view on every navigation, so a carousel with more
  // entries than fit never opens on a screen whose own tab is scrolled off (AC2).
  //
  // Deliberately not `active.scrollIntoView()` (issue #229): that walks every
  // scrollable ancestor, not just this list — on a page with its own horizontal
  // overflow it can nudge `document.scrollingElement` too, visibly shifting the
  // sticky bar (AC3). It also has no concept of "clamp to this list's own scroll
  // range", so centering the last/first entry can rest one snap point short of the
  // edge, leaving an empty slot (AC1/AC2). Computing the target from this list's own
  // geometry and clamping to its own scrollable range fixes both by construction.
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const active = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    // An explicit 'smooth' always animates, regardless of CSS `scroll-behavior` — so
    // reduced motion (OS preference or the in-app toggle, tokens.css) has to be read
    // here too, not just left to CSS (AC5).
    const reduceMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.getAttribute('data-reduce-motion') === 'true';
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const delta = activeRect.left + activeRect.width / 2 - (listRect.left + listRect.width / 2);
    const maxScrollLeft = list.scrollWidth - list.clientWidth;
    const target = Math.max(0, Math.min(list.scrollLeft + delta, maxScrollLeft));
    list.scrollTo({ left: target, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [pathname]);

  return (
    <nav aria-label="Hauptnavigation" className="nav">
      <ul className="nav__list" ref={listRef}>
        {visibleItems.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href} className="nav__item">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className="nav__link"
                style={active ? { color: tab.accent } : undefined}
                // The nonce-based CSP (issue #753) makes the (app) segment dynamic
                // (layout.tsx reads headers() for the nonce), reversing the static
                // prerendering from #599. Next's default 'auto' prefetch only fetches
                // a dynamic route up to its nearest loading.js — this project has
                // none — so without this, the router cache stays empty and both the
                // "no request on click" and offline-navigation specs regress.
                // prefetch={true} forces the full route + data regardless.
                prefetch={true}
              >
                <span aria-hidden="true" className="nav__icon">
                  <tab.Icon />
                </span>
                <span className="nav__label">{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
