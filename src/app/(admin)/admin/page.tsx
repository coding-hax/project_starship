import type { Viewport } from 'next';
import Link from 'next/link';
import { AdminOverview } from '@/features/admin/admin-overview';
import { IconChevronLeft } from '@/ui/icons';
import './admin.css';

export const metadata = { title: 'Verwaltung · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#7d858d' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

/** The role/session gate lives in `(admin)/layout.tsx` — not middleware.ts's
 * cookie-only check alone (AK1), see that file for why. */
export default function AdminPage() {
  return (
    <main className="admin__main">
      <header className="admin__topbar">
        <Link href="/einstellungen" className="admin__back">
          <IconChevronLeft />
          Einstellungen
        </Link>
        <h1 className="admin__title">Verwaltung</h1>
      </header>
      <AdminOverview />
    </main>
  );
}
