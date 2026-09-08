import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createThrowawaySession } from './helpers';
import { waitForRouteReady } from './route-readiness';
import { DEV_SERVER_READY_TIMEOUT_MS, LOCK_FILE, PORT, PORT_PROD } from './run-lock';

type Lock = { pid: number; startedAt: string };

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as Lock;
    return typeof lock.pid === 'number' ? lock : null;
  } catch {
    // Truncated or hand-edited: treat it like no lock at all rather than blocking forever.
    return null;
  }
}

/**
 * Waits for the route the `setup` project is about to authenticate against to be past
 * Next dev's on-demand compile (issue #1142).
 *
 * `webServer.url` (checked before this file ever runs) only proves the root URL answers
 * — a cold worktree's first request to `/uebersicht` still needed 59s to compile, well
 * past the 30s default navigation timeout `registerPasskey` relies on later. That
 * existing timeout stays untouched (AK4): once this resolves, the route really is warm,
 * so 30s is a real bound again, not a coin flip against the on-demand compiler.
 *
 * A plain unauthenticated request doesn't prove readiness either — `middleware.ts`
 * redirects it to `/anmelden` before the destination page ever gets a chance to compile
 * (AK2), so a fast redirect would look identical to "ready". This mints a real,
 * throwaway `sessions` row instead (same mechanism `auth-geraete.spec.ts` uses elsewhere)
 * and requests the route with it. `auth.setup.ts`'s `resetDatabase()` deletes that row
 * along with everything else before the real ceremony starts.
 */
async function waitForColdRouteReady(): Promise<void> {
  const scope = process.env.E2E_SCOPE ?? 'all';
  const port = scope === 'offline' ? PORT_PROD : PORT;
  const session = await createThrowawaySession();

  await waitForRouteReady(
    async () => {
      let response: Response;
      try {
        response = await fetch(`http://localhost:${port}/uebersicht`, {
          headers: { cookie: `starship_session=${session.token}` },
          redirect: 'manual',
        });
      } catch (error) {
        return { ready: false, detail: error instanceof Error ? error.message : String(error) };
      }
      return response.status === 200
        ? { ready: true, detail: 'ok' }
        : { ready: false, detail: `HTTP ${response.status}` };
    },
    { route: '/uebersicht', deadlineMs: DEV_SERVER_READY_TIMEOUT_MS },
  );
}

/**
 * Every run — ours, the IDE's test-server, a subagent's — goes through this file, so the
 * lock catches all of them. What it buys: a second run dies in seconds with its reason
 * spelled out, instead of timing out inside `beforeEach` and looking like broken auth.
 *
 * The port is Playwright's job, not ours: `reuseExistingServer: false` makes it refuse to
 * start when something else holds 3100. This hook cannot do that anyway — the web server
 * boots before global setup runs.
 */
export default async function globalSetup(): Promise<void> {
  // CI runs one job against its own database — nothing to collide with, so the lock
  // below is skipped there. The cold-route wait has nothing to do with that lock and
  // runs regardless: a fresh CI runner has no warm `.next` cache either.
  if (!process.env.CI) {
    const lock = existsSync(LOCK_FILE) ? readLock() : null;

    if (lock && isAlive(lock.pid)) {
      throw new Error(
        `\n\nEs läuft bereits ein E2E-Lauf (PID ${lock.pid}, gestartet ${lock.startedAt}).\n` +
          `Zwei Läufe teilen sich eine Datenbank und löschen sich gegenseitig die Anmeldedaten —\n` +
          `die Tests scheitern dann in beforeEach und sehen aus, als wäre Auth kaputt.\n\n` +
          `Beende ihn oder warte, bis er fertig ist:  kill ${lock.pid}\n`,
      );
    }

    // A dead PID in the lock file means a run crashed. Take it over instead of demanding cleanup.
    if (lock && !isAlive(lock.pid)) unlinkSync(LOCK_FILE);

    const own: Lock = { pid: process.pid, startedAt: new Date().toISOString() };
    // #204: LOCK_FILE now lives under a shared directory outside every clone
    // (~/.starship-runner by default), which doesn't exist yet on a fresh
    // machine — the old process.cwd() location was always there. Without this,
    // the very first E2E run anywhere would fail with ENOENT.
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify(own));
  }

  await waitForColdRouteReady();
}
