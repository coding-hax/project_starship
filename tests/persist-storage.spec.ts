import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
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

test('does not re-request persistence once already granted', async ({ page }) => {
  await stubStorage(page, { persisted: true, persist: true });
  await registerPasskey(page);

  await expect.poll(() => page.evaluate(() => window.__starship.persistStatus())).toBe('granted');
  expect(await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(0);
});

test('a denied request does not crash the app', async ({ page }) => {
  await stubStorage(page, { persisted: false, persist: false });
  await registerPasskey(page);

  await expect(page.getByRole('heading', { name: 'Heute', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.persistStatus())).toBe('denied');
});

test('a missing storage API does not crash the app', async ({ page }) => {
  await stubStorage(page, 'unsupported');
  await registerPasskey(page);

  await expect(page.getByRole('heading', { name: 'Heute', level: 1 })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__starship.persistStatus()))
    .toBe('unsupported');
});
