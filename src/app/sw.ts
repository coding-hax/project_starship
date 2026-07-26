/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';
import { buildNotification, parsePushPayload } from '@/push/notification';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    // E2E-only hooks (issue #122) — tree-shaken out of the production bundle,
    // see the NEXT_PUBLIC_E2E check below.
    __pushTest?: (data: unknown) => Promise<void>;
    __lastNotificationClick?: string;
    // Headless Chromium on Linux CI has no real notification service: even with
    // context.grantPermissions(['notifications']), self.registration.showNotification()
    // throws (confirmed in #122, both e2e-main and e2e-offline). These record the
    // attempt so push-sw.prod.spec.ts can verify the handler built and tried to
    // show/click the right notification without depending on Chromium actually
    // being able to display one.
    __e2eShownNotifications?: ReturnType<typeof buildNotification>[];
    __simulateNotificationClick?: (url: string) => Promise<void>;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Chromium throws a plain TypeError (not a DOMException) for this specific
// check, so match on message rather than error.name/instanceof DOMException.
function isMissingNotificationService(error: unknown): boolean {
  return error instanceof Error && /No notification permission has been granted/.test(error.message);
}

// Client.focus() is spec-gated on user activation. A real notificationclick
// (the only place this normally runs) carries that; our E2E-only synthetic
// click (see __simulateNotificationClick below) does not, so it throws here.
function isMissingUserActivation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidAccessError';
}

async function showPushNotification(data: unknown): Promise<void> {
  const payload = parsePushPayload(data);
  if (!payload) return;
  const notification = buildNotification(payload);
  try {
    await self.registration.showNotification(notification.title, notification.options);
  } catch (error) {
    if (process.env.NEXT_PUBLIC_E2E !== '1' || !isMissingNotificationService(error)) throw error;
  }
  if (process.env.NEXT_PUBLIC_E2E === '1') {
    self.__e2eShownNotifications = [...(self.__e2eShownNotifications ?? []), notification];
  }
}

async function focusOrOpenClient(url: string): Promise<void> {
  try {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  } catch (error) {
    if (process.env.NEXT_PUBLIC_E2E !== '1' || !isMissingUserActivation(error)) throw error;
  }
}

async function handleNotificationClick(url: string, notification: { close(): void }): Promise<void> {
  notification.close();
  if (process.env.NEXT_PUBLIC_E2E === '1') {
    self.__lastNotificationClick = url;
  }
  await focusOrOpenClient(url);
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotification(event.data?.json()));
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data?.url as string | undefined) ?? '/';
  event.waitUntil(handleNotificationClick(url, event.notification));
});

if (process.env.NEXT_PUBLIC_E2E === '1') {
  self.__pushTest = showPushNotification;
  // Constructing a real NotificationEvent needs a real Notification instance,
  // which registration.getNotifications() never has here (see above) — this
  // drives the same handler the real listener above calls, just with a
  // synthetic notification, since only Chromium's display step is unavailable.
  self.__simulateNotificationClick = (url: string) => handleNotificationClick(url, { close: () => {} });
}

// An already-installed PWA may still hold `/heute` as its start_url or in a cached
// tab. This must win over Serwist's own routing/precache — including fully offline,
// where there is no server to run the next.config.ts redirect (issue #161).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate' && url.pathname === '/heute') {
    event.respondWith(Response.redirect('/uebersicht', 308));
  }
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();
