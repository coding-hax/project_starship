import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { deleteJournal } from '@/features/admin/account-actions';

/** Journal hart löschen (S5, #1204 AK4) — getrennt von Konto löschen (AK5). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardAdmin(request, { mutating: true });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

  const { id } = await params;
  const result = await deleteJournal(admin.userId, id);

  if (result === 'self') {
    return NextResponse.json({ error: 'self' }, { status: 403 });
  }
  if (result === 'not-found') {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
