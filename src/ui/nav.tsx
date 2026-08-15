'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
// Not part of the public `next/navigation` surface, but `router.prefetch`'s own
// `options.kind` is typed against this enum, and there is no other way to request a
// full prefetch imperatively (see the effect below for why that matters).
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types';
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
  const router = useRouter();
  const { items } = useNavOrder();
  const { isActive } = useModules();
  const visibleItems = items.filter((item) => isActive(item.id));
  const listRef = useRef<HTMLUListElement>(null);

  // `<Link prefetch={true}>` below only picks the fetch STRATEGY (full vs. partial) —
  // it does not bypass Next's IntersectionObserver-gated visibility check (see
  // node_modules/next/dist/client/components/links.js: `rescheduleLinkPrefetch`
  // cancels/never starts a prefetch while `isVisible` is false). On mobile the
  // carousel (issue #205) keeps a sixth tab scrolled out of view by design, and even
  // on-screen tabs can rack up transient visibility flips while the overview's async
  // modules settle and shift layout. Both silently drop that tab's prefetch — the
  // router cache stays incomplete and the offline nav walk (AK2, issue #753) regresses
  // nondeterministically depending on which tab loses the race. `router.prefetch`
  // schedules unconditionally, independent of DOM visibility.
  //
  // Keyed on the joined hrefs, not `visibleItems` itself: `useNavOrder()` rebuilds its
  // `items` array from scratch on every render (`resolveOrder()`, use-nav-order.ts),
  // so an array/object dependency here would re-run this effect on every one of Nav's
  // re-renders, not just when the active set actually changes. Next's own scheduler
  // treats a repeated `prefetch()` call for a href already in flight as a reschedule,
  // not a no-op — enough re-renders in the overview's async-settling window (weather,
  // task/routine counts) kept restarting the fetch before it ever finished.
  const prefetchHrefs = visibleItems.map((tab) => tab.href).join(',');
  useEffect(() => {
    if (!prefetchHrefs) return;
    for (const href of prefetchHrefs.split(',')) {
      router.prefetch(href, { kind: PrefetchKind.FULL });
    }
  }, [prefetchHrefs, router]);

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
                // The imperative `router.prefetch()` effect above is the single source
                // of truth for prefetching these routes (issue #753). Link's own
                // prefetch, even at prefetch={true}, mounts a SEPARATE, independently
                // scheduled prefetch task (next/dist/client/components/links.js,
                // mountLinkInstance/observeVisibility) — running both raced two
                // competing fetches for the same href against each other, and Next
                // cancels one when the other supersedes it (net::ERR_ABORTED after the
                // response headers had already arrived), intermittently losing the one
                // this component's own effect needs to finish. prefetch={false} turns
                // Link's mechanism off entirely so there is only ever one.
                prefetch={false}
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
