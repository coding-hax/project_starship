export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
}

export interface BuiltNotification {
  title: string;
  options: { body: string; data: { url: string } };
}

/** Pure so it's testable in Vitest without a real ServiceWorkerGlobalScope. */
export function buildNotification(payload: PushNotificationPayload): BuiltNotification {
  return {
    title: payload.title,
    options: { body: payload.body, data: { url: payload.url } },
  };
}

/** Narrows an arbitrary push payload before it reaches buildNotification. */
export function parsePushPayload(data: unknown): PushNotificationPayload | null {
  if (!data || typeof data !== 'object') return null;
  const { title, body, url } = data as Record<string, unknown>;
  if (typeof title !== 'string' || typeof body !== 'string' || typeof url !== 'string') {
    return null;
  }
  return { title, body, url };
}
