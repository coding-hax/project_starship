import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { verifyStepUp } from '@/auth/step-up';
import { reissueAccess } from '@/features/admin/account-actions';

/** Zugang neu ausstellen (S5, #1204 AK3). Der Link steht genau in dieser einen
 * Antwort — danach kennt die Datenbank nur noch `hash(token)`. Unumkehrbar
 * (widerruft jedes Gerät), verlangt eine frische Passkey-Bestätigung (#1224 AK10). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardAdmin(request, { mutating: true });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

  if (!(await verifyStepUp(request, admin))) {
    return NextResponse.json({ error: 'step-up-required' }, { status: 403 });
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
