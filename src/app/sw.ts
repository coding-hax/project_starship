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
  }
}

declare const self: ServiceWorkerGlobalScope;

async function showPushNotification(data: unknown): Promise<void> {
  const payload = parsePushPayload(data);
  if (!payload) return;
  const notification = buildNotification(payload);
  await self.registration.showNotification(notification.title, notification.options);
}

async function focusOrOpenClient(url: string): Promise<void> {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if ('focus' in client) {
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotification(event.data?.json()));
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data?.url as string | undefined) ?? '/';
  event.notification.close();
  if (process.env.NEXT_PUBLIC_E2E === '1') {
    self.__lastNotificationClick = url;
  }
  event.waitUntil(focusOrOpenClient(url));
});

if (process.env.NEXT_PUBLIC_E2E === '1') {
  self.__pushTest = showPushNotification;
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
