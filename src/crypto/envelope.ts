import { base64ToBytes, bytesToBase64 } from './base64';
import { WrongPassphraseError } from './errors';

export interface KdfParams {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}

export interface Envelope {
  v: 1;
  kdfParams: KdfParams;
  wrappedDek: string;
  nonce: string;
}

export const DEFAULT_KDF_PARAMS: Omit<KdfParams, 'salt'> = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600_000,
};

export async function deriveKek(passphrase: string, kdfParams: KdfParams): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(kdfParams.salt),
      iterations: kdfParams.iterations,
      hash: kdfParams.hash,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Wraps an existing extractable DEK under a KEK derived from `secret` (passphrase or
 * recovery key — deriveKek treats both as arbitrary secret text). `createEnvelope`
 * uses this for a freshly generated DEK; `createEnvelopesWithRecovery` (S6, issue
 * #343) reuses it to wrap the *same* DEK under two different KEKs.
 */
export async function wrapDek(
  dek: CryptoKey,
  secret: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdfParams: KdfParams = { ...kdfParamsOverride, salt: bytesToBase64(salt) };
  const kek = await deriveKek(secret, kdfParams);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDek = await crypto.subtle.wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv: nonce,
  });

  return {
    v: 1,
    kdfParams,
    wrappedDek: bytesToBase64(new Uint8Array(wrappedDek)),
    nonce: bytesToBase64(nonce),
  };
}

export async function createEnvelope(
  passphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<Envelope> {
  // wrapKey requires an extractable key to wrap. The handle is discarded right
  // after wrapping — it is never returned, so the raw DEK bytes never leave WebCrypto.
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  return wrapDek(dek, passphrase, kdfParamsOverride);
}

async function unwrapDek(
  envelope: Envelope,
  secret: string,
  extractable: boolean,
): Promise<CryptoKey> {
  const kek = await deriveKek(secret, envelope.kdfParams);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToBytes(envelope.wrappedDek),
      kek,
      { name: 'AES-GCM', iv: base64ToBytes(envelope.nonce) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

export async function openEnvelope(envelope: Envelope, passphrase: string): Promise<CryptoKey> {
  return unwrapDek(envelope, passphrase, false);
}

/**
 * Same as `openEnvelope` but returns an extractable DEK. Used only by
 * `rewrapPassphrase` (S6, issue #343) to re-wrap an existing DEK under a new
 * passphrase-KEK without re-encrypting entries — the extractable handle never
 * leaves that function's local scope (ADR-0016: the DEK stays non-extractable
 * everywhere else, including the running session).
 */
export async function openEnvelopeExtractable(envelope: Envelope, secret: string): Promise<CryptoKey> {
  return unwrapDek(envelope, secret, true);
}
