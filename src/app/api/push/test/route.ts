import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { requireUser } from '@/auth/session';
import { sendPushToUser } from '@/push/send';

/** Manual test send (AC1) — the real reminders (due tasks, streaks) are separate tickets. */
export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  await sendPushToUser(user.userId, {
    title: 'Starship',
    body: 'Testnachricht',
    url: '/',
  });

  return NextResponse.json({ ok: true });
}
