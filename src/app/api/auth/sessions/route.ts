import { NextResponse } from 'next/server';
import { countOtherSessions, endOtherSessions, requireOwner, UnauthorizedError } from '@/auth/session';

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

  return NextResponse.json({ otherCount: await countOtherSessions() });
}

export async function DELETE() {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;

  return NextResponse.json({ endedCount: await endOtherSessions() });
}
