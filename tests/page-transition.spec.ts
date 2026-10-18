import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('prefers-reduced-motion collapses the transition to an instant, pure opacity swap (issue #434 AC2)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerPasskey(page);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Aufgaben' }).click();
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 1 })).toBeVisible();

  const wrapper = page.locator('.page-transition');
  const { animationDuration, transform } = await wrapper.evaluate((el) => {
    const style = getComputedStyle(el);
    return { animationDuration: style.animationDuration, transform: style.transform };
  });

  expect(parseFloat(animationDuration)).toBeLessThan(0.001);
  expect(transform).toBe('none');
});
