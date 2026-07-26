'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
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
  const listRef = useRef<HTMLUListElement>(null);

  // Scrolls the current tab into view on every navigation, so a carousel with more
  // entries than fit never opens on a screen whose own tab is scrolled off (AC2).
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const active = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    // An explicit 'smooth' always animates, regardless of CSS `scroll-behavior` — so
    // reduced motion (OS preference or the in-app toggle, tokens.css) has to be read
    // here too, not just left to CSS (AC6).
    const reduceMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.getAttribute('data-reduce-motion') === 'true';
    active.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [pathname]);

  return (
    <nav aria-label="Hauptnavigation" className="nav">
      <ul className="nav__list" ref={listRef}>
        {items.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href} className="nav__item">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className="nav__link"
                style={active ? { color: tab.accent } : undefined}
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
