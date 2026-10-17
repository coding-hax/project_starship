import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { endSession, requireUser } from '@/auth/session';

/** Idempotent on "not-found"; the caller's own session is never revocable here (issue #1103 AC5) — that is "App sperren"'s job. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  const result = await endSession(user.userId, id);

  if (result === 'self') {
    return NextResponse.json(
      { error: 'Die eigene Sitzung endet über „App sperren".' },
      { status: 409 },
    );
  }

  return NextResponse.json({ deleted: result === 'deleted' });
}
