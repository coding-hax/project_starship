import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireAdmin } from '@/auth/session';
import { blockAccount, deleteAccount, unblockAccount } from '@/features/admin/account-actions';

function statusOf(result: 'ok' | 'self' | 'not-found' | 'last-admin'): number {
  if (result === 'ok') return 200;
  if (result === 'self') return 403;
  if (result === 'not-found') return 404;
  return 409;
}

/**
 * Sperren/Entsperren (S5, #1204 AK1/AK2/AK6). Mirrors
 * `credentials/[id]/route.ts`'s shape — never returns a content field (AK9).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const body = await request.json().catch(() => null);
  if (body === null || (body.action !== 'block' && body.action !== 'unblock')) {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  const { id } = await params;
  const result =
    body.action === 'block' ? await blockAccount(admin.userId, id) : await unblockAccount(admin.userId, id);

  if (result !== 'ok') {
    return NextResponse.json({ error: result }, { status: statusOf(result) });
  }
  return NextResponse.json({ ok: true });
}

/** Konto löschen (AK5/AK6/AK7). */
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
  const result = await deleteAccount(admin.userId, id);

  if (result !== 'ok') {
    return NextResponse.json({ error: result }, { status: statusOf(result) });
  }
  return NextResponse.json({ ok: true });
}
