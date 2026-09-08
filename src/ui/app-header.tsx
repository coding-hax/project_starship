'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconSettings } from './icons';

type AppHeaderProps = {
  /**
   * 'chrome' lives in the shared app shell: hidden on mobile (where Einstellungen is
   * only reachable from /uebersicht, issue #126) and shown from 768px to 1439px,
   * since the sidebar has room there. 'inline' is the mobile entry point itself,
   * rendered by the Übersicht page next to its heading. 'sidebar' is the third
   * desktop stage (issue #1116, ADR-0030): mounted by Nav itself and pinned to the
   * foot of the sidebar from 1440px up — the only variant with a visible text label
   * next to the icon, since it no longer shares a row with anything that would
   * explain the icon alone.
   */
  variant?: 'chrome' | 'inline' | 'sidebar';
};

export function AppHeader({ variant = 'chrome' }: AppHeaderProps) {
  const pathname = usePathname();
  const settingsActive = pathname === '/einstellungen' || pathname.startsWith('/einstellungen/');

  return (
    <header className={`app-header app-header--${variant}`}>
      <Link
        href="/einstellungen"
        aria-label="Einstellungen"
        aria-current={settingsActive ? 'page' : undefined}
        className="app-header__settings"
      >
        <span aria-hidden="true" className="app-header__icon">
          <IconSettings />
        </span>
        {variant === 'sidebar' && <span className="app-header__label">Einstellungen</span>}
      </Link>
    </header>
  );
}
