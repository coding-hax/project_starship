import { describe, expect, it } from 'vitest';
import { RouteNotReadyError, waitForRouteReady } from './route-readiness';

/** A fake clock that only moves when `sleep` is called — no real waiting, ever. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe('waitForRouteReady', () => {
  it('sofort bereit: löst ohne zu schlafen auf', async () => {
    const clock = fakeClock();
    let probeCalls = 0;

    await waitForRouteReady(
      async () => {
        probeCalls += 1;
        return { ready: true, detail: 'ok' };
      },
      { route: '/uebersicht', deadlineMs: 10_000, now: clock.now, sleep: clock.sleep },
    );

    expect(probeCalls).toBe(1);
  });

  it('verzögert bereit: löst auf, sobald die Probe bereit meldet', async () => {
    const clock = fakeClock();
    let probeCalls = 0;

    await waitForRouteReady(
      async () => {
        probeCalls += 1;
        return probeCalls < 3
          ? { ready: false, detail: 'HTTP 307' }
          : { ready: true, detail: 'ok' };
      },
      {
        route: '/uebersicht',
        deadlineMs: 10_000,
        intervalMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(probeCalls).toBe(3);
  });

  it('nie bereit: scheitert einmalig mit einer knappen Diagnose, keine unbegrenzten Wiederholungen', async () => {
    const clock = fakeClock();
    let probeCalls = 0;

    await expect(
      waitForRouteReady(
        async () => {
          probeCalls += 1;
          return { ready: false, detail: 'HTTP 307' };
        },
        {
          route: '/uebersicht',
          deadlineMs: 5_000,
          intervalMs: 1_000,
          now: clock.now,
          sleep: clock.sleep,
        },
      ),
    ).rejects.toThrow(RouteNotReadyError);

    // Bounded by deadlineMs / intervalMs — not an unbounded retry loop.
    expect(probeCalls).toBe(5);
  });

  it('nie bereit: die Diagnose nennt Route und letzten Zustand', async () => {
    const clock = fakeClock();

    await expect(
      waitForRouteReady(async () => ({ ready: false, detail: 'HTTP 307' }), {
        route: '/uebersicht',
        deadlineMs: 1_000,
        intervalMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/\/uebersicht.*HTTP 307/);
  });
});
