'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The Einstellungen entry point. Lives outside <Nav> so a fifth bottom-nav slot
 * doesn't have to compete with it for width at 375px (issue #123).
 */
export function AppHeader() {
  const pathname = usePathname();
  const settingsActive = pathname === '/einstellungen' || pathname.startsWith('/einstellungen/');

  return (
    <header className="app-header">
      <Link
        href="/einstellungen"
        aria-label="Einstellungen"
        aria-current={settingsActive ? 'page' : undefined}
        className="app-header__settings"
      >
        <span aria-hidden="true" className="app-header__icon">
          ⚙
        </span>
      </Link>
    </header>
  );
}
