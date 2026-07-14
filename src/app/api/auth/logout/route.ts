import { NextResponse } from 'next/server';
import { destroySession } from '@/auth/session';

export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
