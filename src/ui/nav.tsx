'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * One navigation, two shapes: bottom bar on mobile, sidebar from `md` up.
 * Not a second design — the same links, laid out differently (DESIGN_SYSTEM.md).
 *
 * Habits deliberately have no tab; they live inside "Heute".
 */
const TABS = [
  { href: '/heute', label: 'Heute', accent: 'var(--accent)', icon: '◉' },
  { href: '/aufgaben', label: 'Aufgaben', accent: 'var(--area-tasks)', icon: '✓' },
  { href: '/kalender', label: 'Kalender', accent: 'var(--area-events)', icon: '▤' },
  { href: '/journal', label: 'Journal', accent: 'var(--area-journal)', icon: '✎' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Hauptnavigation" className="nav">
      <ul className="nav__list">
        {TABS.map((tab) => {
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
                  {tab.icon}
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
