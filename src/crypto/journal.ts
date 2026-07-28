import { JournalDecryptError } from './errors';

export * from './envelope';

export interface JournalContent {
  text: string;
  mood?: string;
  tags?: string[];
}

export interface EncryptedJournal {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
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
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Promise<JournalContent> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, dek, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as JournalContent;
  } catch {
    throw new JournalDecryptError();
  }
}
