import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireAdmin } from '@/auth/session';
import { getAccountsOverview } from '@/features/admin/accounts-overview';

/**
 * Read-only account overview (S4, #1203) — no user content ever leaves here
 * (AK8): only counts, byte sizes and timestamps, see `getAccountsOverview()`.
 */
export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json(await getAccountsOverview());
}
