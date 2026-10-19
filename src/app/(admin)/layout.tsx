import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/auth/session';

/**
 * The role gate for every route under `(admin)` (AK1, #1203; #1224 AK5) — a
 * layout, not a check inside `admin/page.tsx` itself: `notFound()` thrown from
 * a bare page with no layout of its own in its group does not go through the
 * same per-segment boundary a layout gives it, and fell back to Next's raw,
 * minimal error shell instead of the ordinary `not-found` render — confirmed
 * by e2e, several KB apart from a genuinely unmatched route. A missing
 * session redirects the same way `(app)` routes would if middleware ever let
 * one through; `notFound()` for a signed-in non-admin is 404, not 403 — the
 * existence of `/admin` is not information a non-admin account gets to have.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/anmelden');
  if (session.role !== 'admin') notFound();

  return children;
}
