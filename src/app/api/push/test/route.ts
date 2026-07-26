import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { sendPushToAll } from '@/push/send';

/** Manual test send (AC1) — the real reminders (due tasks, streaks) are separate tickets. */
export async function POST() {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  await sendPushToAll({
    title: 'Starship',
    body: 'Testnachricht',
    url: '/',
  });

  return NextResponse.json({ ok: true });
}
