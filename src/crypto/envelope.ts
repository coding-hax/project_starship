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

export async function createEnvelope(passphrase: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdfParams: KdfParams = { ...DEFAULT_KDF_PARAMS, salt: bytesToBase64(salt) };
  const kek = await deriveKek(passphrase, kdfParams);

  // wrapKey requires an extractable key to wrap. The handle is discarded right
  // after wrapping — it is never returned, so the raw DEK bytes never leave WebCrypto.
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
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

export async function openEnvelope(envelope: Envelope, passphrase: string): Promise<CryptoKey> {
  const kek = await deriveKek(passphrase, envelope.kdfParams);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToBytes(envelope.wrappedDek),
      kek,
      { name: 'AES-GCM', iv: base64ToBytes(envelope.nonce) },
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}
