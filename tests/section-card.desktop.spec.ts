import { expect, test } from '@playwright/test';
import { registerPasskey } from './helpers';

/**
 * Desktop-only: the 480px cap only exists below 768px (section-card.css) — see
 * shell.desktop.spec.ts for why this layout assertion lives in its own file
 * instead of a runtime `test.skip`.
 */

test('.section-card verliert ab 768px seinen 480px-Deckel (issue #1017 AK4)', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  // A synthetic 674px column: wider than the old 480px cap, narrower than any
  // real desktop column (.shell__main tops out at 816px) — so the assertion
  // can only pass if the card actually fills its container, not by accident.
  const width = await page.evaluate(() => {
    const column = document.createElement('div');
    column.style.width = '674px';
    const card = document.createElement('div');
    card.className = 'section-card';
    column.appendChild(card);
    document.querySelector('main')!.appendChild(column);
    const measured = card.getBoundingClientRect().width;
    column.remove();
    return measured;
  });

  expect(width).toBe(674);
});
