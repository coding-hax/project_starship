import { NextResponse } from 'next/server';
import { currentCredentialId, requireOwner, UnauthorizedError } from '@/auth/session';
import { listCredentialsForDisplay } from '@/auth/webauthn';

export async function GET() {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const [credentials, current] = await Promise.all([
    listCredentialsForDisplay(),
    currentCredentialId(),
  ]);
  return NextResponse.json({
    credentials: credentials.map((c) => ({ ...c, current: c.id === current })),
  });
}
