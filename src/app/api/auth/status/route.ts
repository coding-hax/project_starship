import { NextResponse } from 'next/server';
import { getSession } from '@/auth/session';
import { hasAnyCredential } from '@/auth/webauthn';

/** Lets the client decide between "first setup" and "log in". Leaks nothing useful. */
export async function GET() {
  return NextResponse.json({
    registered: await hasAnyCredential(),
    authenticated: (await getSession()) !== null,
  });
}
