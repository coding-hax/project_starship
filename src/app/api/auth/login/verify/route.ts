import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createSession, pruneExpired } from '@/auth/session';
import { consumeChallenge, relyingParty } from '@/auth/webauthn';
import { db } from '@/db';
import { credentials } from '@/db/schema';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.response || typeof body.challenge !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  if (!(await consumeChallenge(body.challenge, 'authentication'))) {
    return NextResponse.json({ error: 'Challenge abgelaufen.' }, { status: 400 });
  }

  const [credential] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, body.response.id))
    .limit(1);

  if (!credential) {
    return NextResponse.json({ error: 'Unbekannter Passkey.' }, { status: 401 });
  }

  const rp = relyingParty();
  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: body.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.counter,
      transports: credential.transports as never,
    },
  });

  if (!verification.verified) {
    return NextResponse.json({ error: 'Anmeldung fehlgeschlagen.' }, { status: 401 });
  }

  // The signature counter guards against cloned authenticators; it must never go backwards.
  await db
    .update(credentials)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(credentials.id, credential.id));

  await pruneExpired();
  await createSession();

  return NextResponse.json({ verified: true });
}
