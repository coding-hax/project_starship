import { NextResponse } from 'next/server';
import { endSession, requireOwner, UnauthorizedError } from '@/auth/session';

/** Idempotent on "not-found"; the caller's own session is never revocable here (issue #1103 AC5) — that is "App sperren"'s job. */
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
  const result = await endSession(id);

  if (result === 'self') {
    return NextResponse.json(
      { error: 'Die eigene Sitzung endet über „App sperren".' },
      { status: 409 },
    );
  }

  return NextResponse.json({ deleted: result === 'deleted' });
}
