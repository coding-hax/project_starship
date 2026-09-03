'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useModules } from '@/features/settings/use-modules';
import { useNavOrder } from '@/features/settings/use-nav-order';
import { BackgroundArcs } from './background-arcs';

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
      {/* The row's own background, clipped to it (issue #1006): the same arcs the
          page already shows, painted opaquely so card rows scrolling under the
          sticky bar dissolve into the background before they reach the pill.
          Replaces the flat `.nav::before` fill from #908, which only stayed
          seamless as long as someone kept its colour in step with the
          background (#991 AK7). Shares one grid cell with `.nav__bar` and comes
          first in the DOM, so it paints behind the pill without leaving the
          flow (`.nav-ground`, background-arcs.css — an absolutely positioned
          copy took `.nav`'s sticky offset twice for a frame). Hidden from `md`
          up, where the sidebar carries no copy. */}
      <BackgroundArcs variant="nav" />
      <div className="nav__bar">
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
                  // Explicit, not Next's default `auto` (issue #753). The nonce-based CSP
                  // makes layout.tsx read headers(), which renders the whole (app) segment
                  // dynamically instead of statically prerendering it (#599). For a dynamic
                  // route `auto` only prefetches down to the nearest loading.js — this
                  // project has none, so it prefetched nothing usable and the tab switch
                  // stopped being free. `true` requests the full payload either way.
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
      </div>
    </nav>
  );
}
