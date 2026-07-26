import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { ensureVapidConfigured, webpush } from './vapid';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/**
 * Sends `payload` to every stored subscription. A 404/410 means the push
 * service itself says the endpoint is gone — that subscription is deleted
 * outright (no tombstone: this table isn't synced, see src/db/schema.ts).
 * Any other failure is only logged by id/status, never by endpoint or keys
 * (AC5 — those are secrets the moment they leave the device).
 */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  ensureVapidConfigured();

  const subscriptions = await db.select().from(pushSubscriptions);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
      } catch (error) {
        const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
          return;
        }
        console.error('Push delivery failed', { subscriptionId: subscription.id, statusCode });
      }
    }),
  );
}
