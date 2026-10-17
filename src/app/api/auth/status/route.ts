import { NextResponse } from 'next/server';
import { getSession } from '@/auth/session';
import { hasAnyCredential } from '@/auth/webauthn';

/**
 * Lets the client decide between "first setup" and "log in". Leaks nothing useful:
 * `registered` is a yes/no about the installation, and `userId`/`blocked` only
 * appear once the caller already holds a valid session for that account.
 *
 * `userId` is what S2 (#1201) compares its local database against — a device that
 * finds a different account than the one its IndexedDB belongs to wipes before the
 * first pull, instead of showing one person the other's data.
 */
export async function GET() {
  const session = await getSession();

  return NextResponse.json({
    registered: await hasAnyCredential(),
    authenticated: session !== null,
    ...(session
      ? { userId: session.userId, role: session.role, blocked: session.blockedAt !== null }
      : {}),
  });
}
