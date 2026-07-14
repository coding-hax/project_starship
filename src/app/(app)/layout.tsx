import { redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
import { E2EBridge } from '@/ui/e2e-bridge';
import { Nav } from '@/ui/nav';
import { SyncBoot } from '@/ui/sync-boot';

/**
 * The gate for everything behind the login. Checked server-side on every render —
 * a client-side guard would just be a suggestion.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await getSession())) redirect('/anmelden');

  return (
    <div className="shell">
      <Nav />
      <main className="shell__main">{children}</main>
      <SyncBoot />
      {process.env.NEXT_PUBLIC_E2E === '1' && <E2EBridge />}
    </div>
  );
}
