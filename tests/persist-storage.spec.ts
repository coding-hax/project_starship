import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

/** Stubs navigator.storage before any page script runs, and counts persist() calls. */
async function stubStorage(
  page: import('@playwright/test').Page,
  options: { persisted: boolean; persist: boolean } | 'unsupported',
) {
  await page.addInitScript((opts) => {
    (window as unknown as { __persistCalls: number }).__persistCalls = 0;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value:
        opts === 'unsupported'
          ? undefined
          : {
              persisted: async () => opts.persisted,
              persist: async () => {
                (window as unknown as { __persistCalls: number }).__persistCalls += 1;
                return opts.persist;
              },
            },
    });
  }, options);
}

test('requests persistent storage once on app start', async ({ page }) => {
  await stubStorage(page, { persisted: false, persist: true });
  await registerPasskey(page);

  await expect.poll(() => page.evaluate(() => window.__starship.persistStatus())).toBe('granted');
  expect(await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(1);
});
