import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { enforce } from '@/auth/rate-limit';
import { listAllCredentials, relyingParty, storeChallenge } from '@/auth/webauthn';

export async function POST(request: Request) {
  const limited = await enforce(request, 'options');
  if (limited) return limited;

  const rp = relyingParty();
  // Deliberately unauthenticated and deliberately across all accounts: this is a
  // usernameless WebAuthn flow, so allowCredentials must list the known credential
  // IDs before login for the platform to offer them as a choice — and before the
  // ceremony nobody knows whose account it will turn out to be. IDs are not
  // secrets; an observer learns how many passkeys exist on the installation,
  // which is the same trade #1200 inherited from the single-user version
  // (Deep Review F8, AK4). Which account the ceremony belongs to is decided in
  // login/verify, from the credential row.
  const existing = await listAllCredentials();

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
