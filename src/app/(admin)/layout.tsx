import { redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
import { ADMIN_NOT_FOUND_PATH } from '@/auth/admin-route';

/**
 * The role gate for every route under `(admin)` (AK1, #1203; #1224 AK5) — a
 * layout, not a check inside `admin/page.tsx` itself: a bare page with no
 * layout of its own in its group does not go through the same per-segment
 * boundary a layout gives it. A missing session redirects the same way
 * `(app)` routes would if middleware ever let one through; a signed-in
 * non-admin redirects to `ADMIN_NOT_FOUND_PATH` instead of calling
 * `notFound()` directly — even from a layout, `notFound()` answers with this
 * MATCHED segment's own script/style preloads, which a genuinely unmatched
 * route never carries, so it was never byte-identical to one (confirmed by
 * e2e). The existence of `/admin` is not information a non-admin account
 * gets to have either way — 404, not 403.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/anmelden');
  if (session.role !== 'admin') redirect(ADMIN_NOT_FOUND_PATH);

  return children;
}
