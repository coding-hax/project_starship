import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { revokeCredential } from '@/auth/webauthn';

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
