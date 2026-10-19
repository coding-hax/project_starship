import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { verifyStepUp } from '@/auth/step-up';
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
  const guard = await guardAdmin(request, { mutating: true });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

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

/** Konto löschen (AK5/AK6/AK7) — unumkehrbar, verlangt eine frische Passkey-Bestätigung (AK10). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardAdmin(request, { mutating: true });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

  if (!(await verifyStepUp(request, admin))) {
    return NextResponse.json({ error: 'step-up-required' }, { status: 403 });
  }

  const { id } = await params;
  const result = await deleteAccount(admin.userId, id);

  if (result !== 'ok') {
    return NextResponse.json({ error: result }, { status: statusOf(result) });
  }
  return NextResponse.json({ ok: true });
}
