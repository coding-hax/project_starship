import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { endOtherSessions, listSessions, requireUser } from '@/auth/session';

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sessions = await listSessions(user.userId);
  return NextResponse.json({ sessions, otherCount: sessions.filter((s) => !s.current).length });
}

export async function DELETE() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json({ endedCount: await endOtherSessions(user.userId) });
}
