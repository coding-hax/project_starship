import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { createSession } from '@/auth/session';
import {
  burnRecoveryCode,
  consumeChallenge,
  hasAnyCredential,
  issueRecoveryCode,
  relyingParty,
} from '@/auth/webauthn';
import { db } from '@/db';
import { credentials } from '@/db/schema';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.response || typeof body.challenge !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  const { ok, recoveryCodeId } = await consumeChallenge(body.challenge, 'registration');
  if (!ok) {
    return NextResponse.json({ error: 'Challenge abgelaufen.' }, { status: 400 });
  }

  const rp = relyingParty();
  // A recovery-backed verify is never firstCredential, so it never mints a new
  // recovery code — determined before the transaction, same as the credential count.
  const firstCredential = !(await hasAnyCredential());

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: body.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json(
      { error: 'Passkey konnte nicht verifiziert werden.' },
      { status: 400 },
    );
  }

  const { credential } = verification.registrationInfo;

  try {
    await db.transaction(async (tx) => {
      if (recoveryCodeId && !(await burnRecoveryCode(recoveryCodeId, tx))) {
        throw new RecoveryCodeAlreadyUsedError();
      }

      await tx.insert(credentials).values({
        id: uuidv7(),
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label: typeof body.label === 'string' ? body.label : null,
      });
    });
  } catch (error) {
    if (error instanceof RecoveryCodeAlreadyUsedError) {
      return NextResponse.json({ error: 'Recovery-Code bereits verbraucht.' }, { status: 403 });
    }
    throw error;
  }

  await createSession();

  // The recovery code exists once, at first setup, and is never recoverable again.
  const recoveryCode = firstCredential ? await issueRecoveryCode() : null;
  return NextResponse.json({ verified: true, recoveryCode });
}

class RecoveryCodeAlreadyUsedError extends Error {
  constructor() {
    super('Recovery code already used');
    this.name = 'RecoveryCodeAlreadyUsedError';
  }
}
