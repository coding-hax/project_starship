import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { enforce } from '@/auth/rate-limit';
import { listCredentials, relyingParty, storeChallenge } from '@/auth/webauthn';

export async function POST(request: Request) {
  const limited = await enforce(request, 'options');
  if (limited) return limited;

  const rp = relyingParty();
  // Deliberately unauthenticated: this is a usernameless WebAuthn flow, so
  // allowCredentials must list the known credential IDs before login for the
  // platform to offer them as a choice. IDs are not secrets; the only thing an
  // observer learns is how many devices are registered. Accepted for a
  // single-user app in exchange for better passkey selection at sign-in,
  // rather than leaving allowCredentials empty (Deep Review F8, AK4).
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
