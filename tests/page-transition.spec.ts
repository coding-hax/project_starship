import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('the fade keyframe is wired up as a pure opacity transition, no transform (issue #434 AC1)', async ({
  page,
}) => {
  await registerPasskey(page);

  const keyframe = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === 'page-fade-in') {
          const texts = Array.from(rule.cssRules).map((r) => r.cssText);
          return texts.join(' ');
        }
      }
    }
    return null;
  });

  expect(keyframe).not.toBeNull();
  expect(keyframe).toContain('opacity: 0');
  expect(keyframe).toContain('opacity: 1');
  expect(keyframe).not.toContain('transform');
});

test('a tab switch restarts the opacity animation on the transition wrapper (issue #434 AC1)', async ({
  page,
}) => {
  await registerPasskey(page);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Routinen' }).click();
  await expect(page.getByRole('heading', { name: 'Routinen', level: 1 })).toBeVisible();

  const wrapper = page.locator('.page-transition');
  const { animationName, animationDuration, transform } = await wrapper.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      transform: style.transform,
    };
  });

  expect(animationName).toBe('page-fade-in');
  expect(parseFloat(animationDuration)).toBeGreaterThan(0.15);
  expect(parseFloat(animationDuration)).toBeLessThanOrEqual(0.4);
  expect(transform).toBe('none');
});

test('switching tabs never shifts where main starts (issue #434 AC1, regression for #126 AC6)', async ({
  page,
}) => {
  await registerPasskey(page);
  const main = page.locator('main.shell__main');
  const uebersichtY = (await main.boundingBox())!.y;

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  for (const label of ['Aufgaben', 'Routinen', 'Kalender', 'Journal']) {
    await nav.getByRole('link', { name: label }).click();
    const box = await main.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.y - uebersichtY)).toBeLessThan(1);
  }
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

test('the router still focuses the first segment element, not the transition wrapper (issue #434 AC3, regression for #233)', async ({
  page,
}) => {
  await registerPasskey(page);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Journal' }).click();
  // Titel „Wie war dein Tag?“ seit issue #868 — der Nav-Tab heißt weiterhin „Journal“.
  await expect(page.getByRole('heading', { name: 'Wie war dein Tag?', level: 1 })).toBeVisible();

  const wrapperIsFocused = await page.evaluate(
    () => document.activeElement?.classList.contains('page-transition') ?? false,
  );
  expect(wrapperIsFocused).toBe(false);
});

test('dark mode: the fade mechanic still applies without layout shift (issue #434 AC4)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await registerPasskey(page);

  const main = page.locator('main.shell__main');
  const uebersichtY = (await main.boundingBox())!.y;

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Kalender' }).click();
  // Titel „Diese Woche“ seit issue #898 — der Nav-Tab heißt weiterhin „Kalender“.
  await expect(page.getByRole('heading', { name: 'Diese Woche', level: 1 })).toBeVisible();

  const box = await main.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.y - uebersichtY)).toBeLessThan(1);

  const animationName = await page
    .locator('.page-transition')
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(animationName).toBe('page-fade-in');
});
