import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * TEMPORARY diagnostic for issue #683 — deleted before the PR.
 *
 * Runs on the DEFAULT 30s budget, exactly like the real AK2, so it can actually
 * fall over. Everything is logged incrementally (never at the end), because a
 * timed-out test never reaches its final console.log — that is why the first
 * attempt with a 180s budget saw only green.
 *
 * The filename must END in `navigation.prod.spec.ts` so the offline projects'
 * testMatch picks it up — otherwise the run falls back to the dev server.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

test.describe('flake-diagnose', () => {
  test.beforeEach(async ({ page }) => {
    const t0 = Date.now();
    await resetAppData();
    const tReset = Date.now();
    await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
    await registerPasskey(page);
    console.log(
      `[DIAG] hook done: reset=${tReset - t0}ms passkey=${Date.now() - tReset}ms total=${Date.now() - t0}ms`,
    );
  });

  test('AK2-diagnose', async ({ page, context }) => {
    const started = Date.now();
    const el = () => Date.now() - started;
    const pending = new Map<string, number>();

    page.on('request', (r) => pending.set(r.url(), el()));
    page.on('requestfinished', (r) => pending.delete(r.url()));
    page.on('requestfailed', (r) => pending.delete(r.url()));

    // Heartbeat: names what is still in flight while we wait, every 2s. This is the
    // only thing that survives a 30s timeout.
    const heartbeat = setInterval(() => {
      const open = [...pending.entries()].map(
        ([url, t]) => `${url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)} (seit ${el() - t}ms)`,
      );
      console.log(`[DIAG] t=${el()}ms offen=${open.length} :: ${open.join(' | ') || '—'}`);
    }, 2_000);

    try {
      const tGoto = Date.now();
      await page.goto('/uebersicht');
      console.log(`[DIAG] goto fertig nach ${Date.now() - tGoto}ms (t=${el()}ms)`);

      const tIdle = Date.now();
      await page.waitForLoadState('networkidle');
      console.log(`[DIAG] NETZRUHE nach ${Date.now() - tIdle}ms (t=${el()}ms)`);

      // Everything below mirrors the real AK2, so the diagnostic fails where it fails.
      await context.setOffline(true);
      const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
      const stops: Array<[label: string, heading: string]> = [
        ['Aufgaben', 'Aufgaben'],
        ['Kalender', 'Kalender'],
        ['Gewohnheiten', 'Gewohnheiten verwalten'],
        ['Übersicht', 'Übersicht'],
      ];
      for (const [label, heading] of stops) {
        await nav.getByRole('link', { name: label }).click();
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
        await expect(page).not.toHaveURL(/\/offline$/);
        console.log(`[DIAG] offline erreicht: ${label} (t=${el()}ms)`);
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
});
