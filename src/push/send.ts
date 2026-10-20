import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { recordSyncCounters } from '@/db/sync-counters';
import { ensureVapidConfigured, webpush } from './vapid';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/**
 * Sends `payload` to every device of **one account** (ADR-0031). There is no
 * send-to-everyone any more: a notification always belongs to somebody, and a
 * function that could reach every device at once is one forgotten argument away
 * from telling the wrong person about their tasks.
 *
 * A 404/410 means the push service itself says the endpoint is gone — that
 * subscription is deleted outright (no tombstone: this table isn't synced, see
 * src/db/schema.ts). Any other failure is only logged by id/status, never by
 * endpoint or keys (AC5 — those are secrets the moment they leave the device).
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  ensureVapidConfigured();

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  // Per-account tallies (#1235 AK3), not per-subscription: a dropped subscription
  // is gone by the time this returns, so the account is the only thing left to
  // count against.
  let dropped = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          // A single unreachable endpoint (dead device, DNS gone) must not stall
          // every other subscription's delivery.
          { timeout: 10_000 },
        );
      } catch (error) {
        const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
          dropped += 1;
          return;
        }
        failed += 1;
        console.error('Push delivery failed', { subscriptionId: subscription.id, statusCode });
      }
    }),
  );

  try {
    await recordSyncCounters(userId, {
      pushSubscriptionsDropped: dropped,
      pushDeliveryFailures: failed,
    });
  } catch {
    // fail-open (AK6-Geist) — a broken counter must not break push delivery.
  }
}
