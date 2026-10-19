import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireAdmin } from '@/auth/session';
import { deleteJournal } from '@/features/admin/account-actions';

/** Journal hart löschen (S5, #1204 AK4) — getrennt von Konto löschen (AK5). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

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
