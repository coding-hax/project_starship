import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
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

  const credentials = await listCredentialsForDisplay();
  return NextResponse.json({ credentials });
}
