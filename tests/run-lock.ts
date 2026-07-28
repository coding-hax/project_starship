import os from 'node:os';
import path from 'node:path';

// #204: multiple runner slots, each its own clone with its own dev/prod
// server. SLOT_ID is the only slot-specific input (same default as
// scripts/claude-runner.sh) — ports and the lock derive from it so a fresh
// checkout without SLOT_ID set behaves exactly like before (AK9).
const SLOT_ID = Number(process.env.SLOT_ID ?? '1');

/**
 * Shared by global setup and teardown so the two can never disagree on the path.
 * Deliberately NOT under `process.cwd()` (#204): with several slots that's several
 * directories, and the lock would stop protecting anything — two local E2E runs in
 * different slots would happily share one database and delete each other's
 * credentials/sessions (looks like a broken-auth bug, isn't one). One file per SLOT_ID
 * under a location every slot can see, same default as SHARED_DIR in
 * scripts/claude-runner.sh.
 */
export const LOCK_FILE = path.join(process.env.SHARED_DIR ?? path.join(os.homedir(), '.starship-runner'), `e2e-${SLOT_ID}.lock`);

/**
 * The owner session the `setup` project produces and every other project starts from
 * (#115). Lives here rather than in helpers.ts so playwright.config.ts can import it
 * without pulling `pg` into the config load.
 */
export const AUTH_STATE = 'playwright/.auth/owner.json';

// #204: 3100/3110/3120/… — one decade of ports per slot, plenty of room for
// PORT_PROD (+1) and any future port this suite might need. SLOT_ID=1 keeps
// exactly today's 3100 (AK9); DATABASE_URL for slot isolation lives in each
// slot's own .env.local, not here.
export const PORT = 3100 + 10 * (SLOT_ID - 1);

/** Prod-build server for the offline-critical spec — the dev server never ships a service worker. */
export const PORT_PROD = PORT + 1;
