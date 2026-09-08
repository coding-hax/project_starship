import { NextResponse } from 'next/server';
import { endOtherSessions, listSessions, requireOwner, UnauthorizedError } from '@/auth/session';

async function guard() {
  try {
    await requireOwner();
    return null;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }
}

export async function GET() {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;

  const sessions = await listSessions();
  return NextResponse.json({ sessions, otherCount: sessions.filter((s) => !s.current).length });
}

export async function DELETE() {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;

  return NextResponse.json({ endedCount: await endOtherSessions() });
}
