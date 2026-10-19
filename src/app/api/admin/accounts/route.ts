import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { getAccountsOverview } from '@/features/admin/accounts-overview';

/**
 * Read-only account overview (S4, #1203) — no user content ever leaves here
 * (AK8): only counts, byte sizes and timestamps, see `getAccountsOverview()`.
 */
export async function GET(request: Request) {
  const guard = await guardAdmin(request, { mutating: false });
  if ('error' in guard) return guard.error;

  return NextResponse.json(await getAccountsOverview());
}
