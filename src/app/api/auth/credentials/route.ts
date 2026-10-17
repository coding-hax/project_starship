import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { currentCredentialId, requireUser } from '@/auth/session';
import { listCredentialsForDisplay } from '@/auth/webauthn';

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const [credentials, current] = await Promise.all([
    listCredentialsForDisplay(user.userId),
    currentCredentialId(),
  ]);
  return NextResponse.json({
    credentials: credentials.map((c) => ({ ...c, current: c.id === current })),
  });
}
