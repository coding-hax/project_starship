import path from 'node:path';

/** Shared by global setup and teardown so the two can never disagree on the path. */
export const LOCK_FILE = path.join(process.cwd(), '.e2e.lock');

export const PORT = 3100;

/** Prod-build server for the offline-critical spec — the dev server never ships a service worker. */
export const PORT_PROD = 3101;
