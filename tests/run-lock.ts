import path from 'node:path';

/** Shared by global setup and teardown so the two can never disagree on the path. */
export const LOCK_FILE = path.join(process.cwd(), '.e2e.lock');

/**
 * The owner session the `setup` project produces and every other project starts from
 * (#115). Lives here rather than in helpers.ts so playwright.config.ts can import it
 * without pulling `pg` into the config load.
 */
export const AUTH_STATE = 'playwright/.auth/owner.json';

export const PORT = 3100;

/** Prod-build server for the offline-critical spec — the dev server never ships a service worker. */
export const PORT_PROD = 3101;
