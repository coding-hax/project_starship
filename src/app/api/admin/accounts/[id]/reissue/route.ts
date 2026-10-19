import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { reissueAccess } from '@/features/admin/account-actions';

/** Zugang neu ausstellen (S5, #1204 AK3). Der Link steht genau in dieser einen
 * Antwort — danach kennt die Datenbank nur noch `hash(token)`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardAdmin(request, { mutating: true });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

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
