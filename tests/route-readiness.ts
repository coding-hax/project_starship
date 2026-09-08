/**
 * Generic bounded-poll primitive behind the cold-route wait in `auth.setup.ts` (issue
 * #1142). Framework-agnostic on purpose — no Playwright/Next import here — so it can be
 * exercised by Vitest with an injected fake clock instead of waiting out real deadlines
 * (`route-readiness.test.ts`).
 */

export interface RouteProbeResult {
  ready: boolean;
  /** One line describing the current state (e.g. `HTTP 307`) — becomes part of the diagnostic on timeout. */
  detail: string;
}

export type RouteProbe = () => Promise<RouteProbeResult>;

export interface WaitForRouteReadyOptions {
  /** Only used to phrase the timeout diagnostic. */
  route: string;
  deadlineMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RouteNotReadyError extends Error {}

/**
 * Polls `probe` until it reports ready or `deadlineMs` elapses — a single bounded loop,
 * never an unbounded retry. Throws once with a concise diagnostic (last `detail`) rather
 * than leaving the caller to time out on an unrelated assertion (issue #1142, AK3).
 */
export async function waitForRouteReady(
  probe: RouteProbe,
  {
    route,
    deadlineMs,
    intervalMs = 500,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: WaitForRouteReadyOptions,
): Promise<void> {
  const deadline = now() + deadlineMs;
  let lastDetail = 'keine Probe ausgeführt';

  while (now() < deadline) {
    const result = await probe();
    if (result.ready) return;
    lastDetail = result.detail;
    await sleep(intervalMs);
  }

  throw new RouteNotReadyError(
    `${route} wurde nicht innerhalb von ${deadlineMs}ms bereit (zuletzt: ${lastDetail}).`,
  );
}
