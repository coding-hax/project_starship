import webpush from 'web-push';

/**
 * Configured lazily on first send, not on import — importing this module must
 * not require the env vars to exist (see the same reasoning in src/db/index.ts
 * for DATABASE_URL: a missing variable should surface at the first real use,
 * not break `next build` for every route that happens to import this file).
 */
let configured = false;

export function ensureVapidConfigured(): void {
  if (configured) return;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      'VAPID is not configured. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (see .env.example, ADR-0010).',
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export { webpush };
