'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconSettings } from './icons';

type AppHeaderProps = {
  /**
   * 'chrome' lives in the shared app shell: hidden on mobile (where Einstellungen is
   * only reachable from /heute, issue #126) and shown from every screen from `md` up,
   * since the sidebar has room there. 'inline' is the mobile entry point itself,
   * rendered by the Heute page next to its heading.
   */
  variant?: 'chrome' | 'inline';
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
      </Link>
    </header>
  );
}
