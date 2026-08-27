import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { renameCredential, revokeCredential } from '@/auth/webauthn';

/** Idempotent on "not-found"; the last remaining passkey is never revocable (self-lockout guard). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const { id } = await params;
  const result = await revokeCredential(id);

  if (result === 'last-credential') {
    return NextResponse.json(
      { error: 'Das letzte Gerät kann nicht widerrufen werden.' },
      { status: 409 },
    );
  }

  return NextResponse.json({ deleted: result === 'deleted' });
}

/** Empty/whitespace label clears back to "Unbenanntes Gerät" (null in storage). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const body = await request.json().catch(() => null);
  if (body === null || (typeof body.label !== 'string' && body.label !== null)) {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }
  const trimmed = typeof body.label === 'string' ? body.label.trim() : '';
  const label = trimmed.length > 0 ? trimmed : null;

  const { id } = await params;
  const renamed = await renameCredential(id, label);

  if (!renamed) {
    return NextResponse.json({ error: 'Gerät nicht gefunden.' }, { status: 404 });
  }

  return NextResponse.json({ label });
}
