import { JournalDecryptError } from './errors';
import {
  DEFAULT_KDF_PARAMS,
  openEnvelope,
  openEnvelopeExtractable,
  wrapDek,
  type Envelope,
  type KdfParams,
} from './envelope';

export * from './envelope';

export interface JournalContent {
  text: string;
  mood?: string;
  tags?: string[];
}

export interface EncryptedJournal {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
}

export async function encryptJournal(
  dek: CryptoKey,
  content: JournalContent,
): Promise<EncryptedJournal> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(content));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, dek, plaintext);
  return { ciphertext: new Uint8Array(ciphertext), nonce };
}

export async function decryptJournal(
  dek: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
): Promise<JournalContent> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, dek, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as JournalContent;
  } catch {
    throw new JournalDecryptError();
  }
}

/* --------------------------------- recovery (S6, issue #343) --------------------------------- */

const RECOVERY_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32, no padding

/**
 * 256 bits of entropy (`crypto.getRandomValues`), formatted as grouped base32
 * (ADR-0015 point 2) so it reads and copies cleanly — 13 groups of 4 characters.
 * Fed straight into `deriveKek` as secret text, same as a passphrase: there is no
 * need to decode it back to raw bytes, the KDF treats any string as key material.
 * A separate secret from the auth recovery code (ADR-0015 point 5) — never reuse it.
 */
export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bits = 0;
  let value = 0;
  let raw = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      raw += RECOVERY_KEY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    raw += RECOVERY_KEY_ALPHABET[(value << (5 - bits)) & 31];
  }
  return raw.match(/.{1,4}/g)!.join('-');
}

/** Strips whitespace/dashes and uppercases, so pasted or retyped input still matches. */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export interface EnvelopesWithRecovery {
  passphraseEnvelope: Envelope;
  recoveryEnvelope: Envelope;
  recoveryKey: string;
  dek: CryptoKey;
}

/**
 * Creates both KEK wraps for a fresh DEK in one step (AC1). `wrapDek` needs an
 * extractable source key, but the DEK must end up non-extractable (ADR-0016) —
 * so the extractable handle is generated here, wrapped under both KEKs, and then
 * discarded; `dek` on the returned value is the non-extractable copy reopened via
 * the passphrase envelope for the running session.
 */
export async function createEnvelopesWithRecovery(
  passphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<EnvelopesWithRecovery> {
  const recoveryKey = generateRecoveryKey();
  const extractableDek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const [passphraseEnvelope, recoveryEnvelope] = await Promise.all([
    wrapDek(extractableDek, passphrase, kdfParamsOverride),
    wrapDek(extractableDek, normalizeRecoveryKey(recoveryKey), kdfParamsOverride),
  ]);
  const dek = await openEnvelope(passphraseEnvelope, passphrase);
  return { passphraseEnvelope, recoveryEnvelope, recoveryKey, dek };
}

/**
 * Opens the recovery envelope (AC3). Delegates to `openEnvelope`, so a wrong
 * recovery key throws the exact same `WrongPassphraseError` as a wrong passphrase
 * (AC5) — the UI cannot tell, and must not, which secret was wrong.
 */
export async function openEnvelopeWithRecovery(
  envelope: Envelope,
  recoveryKey: string,
): Promise<CryptoKey> {
  return openEnvelope(envelope, normalizeRecoveryKey(recoveryKey));
}

/**
 * Re-wraps the existing DEK under a new passphrase-KEK (AC4) — entries stay
 * encrypted under the same DEK, only the passphrase envelope changes. Recovering
 * an extractable DEK is only safe here because whoever holds the recovery key
 * already has full DEK access regardless (same threat model as ADR-0016); the
 * extractable handle lives only inside this function and is never returned.
 */
export async function rewrapPassphrase(
  recoveryEnvelope: Envelope,
  recoveryKey: string,
  newPassphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<Envelope> {
  const extractableDek = await openEnvelopeExtractable(
    recoveryEnvelope,
    normalizeRecoveryKey(recoveryKey),
  );
  return wrapDek(extractableDek, newPassphrase, kdfParamsOverride);
}
