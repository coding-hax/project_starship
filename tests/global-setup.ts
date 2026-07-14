import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { LOCK_FILE } from './run-lock';

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
 * Every run — ours, the IDE's test-server, a subagent's — goes through this file, so the
 * lock catches all of them. What it buys: a second run dies in seconds with its reason
 * spelled out, instead of timing out inside `beforeEach` and looking like broken auth.
 *
 * The port is Playwright's job, not ours: `reuseExistingServer: false` makes it refuse to
 * start when something else holds 3100. This hook cannot do that anyway — the web server
 * boots before global setup runs.
 */
export default function globalSetup() {
  // CI runs one job against its own database. Nothing to collide with.
  if (process.env.CI) return;

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
  writeFileSync(LOCK_FILE, JSON.stringify(own));
}
