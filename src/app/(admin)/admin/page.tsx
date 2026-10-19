import type { Viewport } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
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

/**
 * Server Component, not gated by middleware.ts's cookie-only check alone (AK1):
 * `getSession()` resolves the account so a signed-in non-admin gets `notFound()`
 * (404, not 403 — the existence of /admin is not information a non-admin gets
 * to have), and a missing session redirects the same way `(app)` routes would
 * if middleware ever let one through.
 */
export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect('/anmelden');
  if (session.role !== 'admin') notFound();

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
