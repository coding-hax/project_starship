import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { listCredentials, relyingParty, storeChallenge } from '@/auth/webauthn';

export async function POST() {
  const rp = relyingParty();
  const existing = await listCredentials();

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    userVerification: 'preferred',
  });

  await storeChallenge(options.challenge, 'authentication');
  return NextResponse.json(options);
}

type AuthenticatorTransport =
  'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
