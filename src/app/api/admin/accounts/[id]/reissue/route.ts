import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireAdmin } from '@/auth/session';
import { reissueAccess } from '@/features/admin/account-actions';

/** Zugang neu ausstellen (S5, #1204 AK3). Der Link steht genau in dieser einen
 * Antwort — danach kennt die Datenbank nur noch `hash(token)`. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  const result = await reissueAccess(admin.userId, id);

  if (result.status === 'self') {
    return NextResponse.json({ error: 'self' }, { status: 403 });
  }
  if (result.status === 'not-found') {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  return NextResponse.json({ link: result.link });
}
