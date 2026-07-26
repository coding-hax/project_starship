/**
 * Push-Abo ist bewusst nicht Outbox-geführt (wie Auth, ADR-0009-Vorwort im Plan zu
 * #122) — es ist Geräte-Infrastruktur, kein Domänendatum. Diese Datei ist deshalb
 * die eine Stelle, die gegen /api/push spricht (check-sync-invariants.sh nimmt
 * src/local/** ausdrücklich aus). Feature-Code ruft nie selbst fetch() auf.
 */

export type PushState = 'unsupported' | 'default' | 'denied' | 'granted';

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  );
}

/**
 * 'granted' means an active subscription exists, not merely that the browser
 * permission is granted — a browser never lets permission go from granted back
 * to default, so unsubscribing (AC2) must still show the same "please activate"
 * state as a fresh install, not a stuck "granted".
 */
export async function getPushState(): Promise<PushState> {
  if (!isSupported()) return 'unsupported';
  const permission = Notification.permission;
  if (permission !== 'granted') return permission;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'granted' : 'default';
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Requests permission (if needed) and creates the subscription server-side. */
export async function subscribeToPush(): Promise<PushState> {
  if (!isSupported()) return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error('NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set.');

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const json = subscription.toJSON();
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
    }),
  });

  return 'granted';
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!isSupported()) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

export async function sendTestPush(): Promise<void> {
  await fetch('/api/push/test', { method: 'POST' });
}
