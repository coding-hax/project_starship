import { generateRegistrationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { getSession } from '@/auth/session';
import {
  hasAnyCredential,
  listCredentials,
  redeemRecoveryCode,
  relyingParty,
  storeChallenge,
} from '@/auth/webauthn';

/**
 * Registration is only ever open in three cases:
 *   1. first setup — no credential exists yet,
 *   2. adding a second device from an already authenticated session,
 *   3. recovery — a valid, unused recovery code.
 * Anything else and a stranger could enrol their own passkey.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const recoveryCode: unknown = body?.recoveryCode;

  const firstSetup = !(await hasAnyCredential());
  const authenticated = (await getSession()) !== null;
  const recovered =
    typeof recoveryCode === 'string' && recoveryCode.length > 0
      ? await redeemRecoveryCode(recoveryCode)
      : false;

  if (!firstSetup && !authenticated && !recovered) {
    return NextResponse.json({ error: 'Registrierung nicht erlaubt.' }, { status: 403 });
  }

  const rp = relyingParty();
  const ownerId = process.env.OWNER_USER_ID;
  if (!ownerId) throw new Error('OWNER_USER_ID is not set.');

  const existing = await listCredentials();
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: new TextEncoder().encode(ownerId),
    userName: 'starship',
    userDisplayName: 'Starship',
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  await storeChallenge(options.challenge, 'registration');
  return NextResponse.json(options);
}
