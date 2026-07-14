import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { LOCK_FILE } from './run-lock';

export default function globalTeardown() {
  if (process.env.CI || !existsSync(LOCK_FILE)) return;

  try {
    // Only ever remove our own lock. If setup aborted because another run holds it,
    // teardown still fires — and must not hand that run's lock away.
    const { pid } = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { pid: number };
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // Unreadable lock: leave it. A dead PID is taken over by the next run anyway.
  }
}
