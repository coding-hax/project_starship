import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

// Drives the auth UI itself and asserts the never-registered state, so it opts out of
// the shared owner session and keeps the full reset (#115).
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  await resetDatabase();
});

test('an unauthenticated visitor is sent to the login', async ({ page }) => {
  await page.goto('/heute');
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(page.getByRole('button', { name: 'Passkey einrichten' })).toBeVisible();
});

test('passkey setup issues a recovery code exactly once and opens the app', async ({ page }) => {
  await registerPasskey(page);
  await expect(page.getByRole('heading', { name: 'Heute', level: 1 })).toBeVisible();

  // Second visit: already authenticated, so no code and no second setup.
  await page.goto('/anmelden');
  await expect(page).toHaveURL(/\/heute$/);
  await expect(page.getByTestId('recovery-code')).toHaveCount(0);
});

test('all five tabs are reachable and mark themselves current (issue #123 AC1)', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const [label, path, heading] of [
    ['Aufgaben', '/aufgaben', 'Aufgaben'],
    ['Gewohnheiten', '/gewohnheiten', 'Gewohnheiten verwalten'],
    ['Kalender', '/kalender', 'Kalender'],
    ['Journal', '/journal', 'Journal'],
    ['Heute', '/heute', 'Heute'],
  ] as const) {
    await page.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
  }
});

test('the navigation marks the current tab', async ({ page }) => {
  await registerPasskey(page);
  await page.getByRole('link', { name: 'Journal' }).click();

  await expect(page.getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Aufgaben' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('every tab label fits on one line with a ≥44×44px touch target (issue #123 AC2)', async ({
  page,
}) => {
  await registerPasskey(page);

  // Scope to the nav: /heute also carries a "Gewohnheiten verwalten" shortcut link,
  // which a bare name match would collide with.
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  for (const label of ['Heute', 'Aufgaben', 'Gewohnheiten', 'Kalender', 'Journal']) {
    const link = nav.getByRole('link', { name: label });
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const wrapped = await link.locator('.nav__label').evaluate((el) => {
      // A wrapped label is roughly twice as tall as its single-line lineHeight.
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return el.clientHeight > lineHeight * 1.5;
    });
    expect(wrapped).toBe(false);
  }
});

test('the nav carries the same five entries in both layouts (issue #123 AC3)', async ({
  page,
}) => {
  await registerPasskey(page);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  for (const label of ['Heute', 'Aufgaben', 'Gewohnheiten', 'Kalender', 'Journal']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('/heute/gewohnheiten permanently redirects to /gewohnheiten instead of 404ing (issue #123 AC4)', async ({
  page,
}) => {
  await registerPasskey(page);

  const response = await page.goto('/heute/gewohnheiten');
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/gewohnheiten$/);
  await expect(page.getByRole('heading', { name: 'Gewohnheiten verwalten', level: 1 })).toBeVisible();

  const redirected = response!.request().redirectedFrom();
  expect(redirected).not.toBeNull();
  expect(await redirected!.response().then((r) => r?.status())).toBe(308);
});

test('Einstellungen is reachable from the header and keeps its active state (issue #123 AC5)', async ({
  page,
}) => {
  await registerPasskey(page);

  const settings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(settings).not.toHaveAttribute('aria-current', 'page');
  await settings.click();
  await expect(page).toHaveURL(/\/einstellungen$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');
});

test('the bottom nav still reserves space for the home indicator (issue #123 AC6)', async ({
  page,
}) => {
  await registerPasskey(page);

  const usesSafeArea = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        // Assert against the rule's serialized text, not `rule.style`: lightningcss
        // lowers the sibling `color-mix()` background into a nested `@supports`, and
        // per CSS nesting the declarations after it — padding-bottom included — move
        // into an implicit `&` block, so `rule.style.paddingBottom` reads empty even
        // though the declaration is still applied to `.nav`.
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText === '.nav' &&
          rule.cssText.includes('padding-bottom: env(safe-area-inset-bottom)')
        ) {
          return true;
        }
      }
    }
    return false;
  });
  expect(usesSafeArea).toBe(true);
});

test('the header and nav respect reduced motion and stay legible in dark mode (issue #123 AC7)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerPasskey(page);

  const settings = page.getByRole('link', { name: 'Einstellungen' });
  const duration = await settings.evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  // Scope to the nav to avoid /heute's "Gewohnheiten verwalten" shortcut link.
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const habitsTab = nav.getByRole('link', { name: 'Gewohnheiten' });
  await habitsTab.click();
  await expect(habitsTab).toHaveAttribute('aria-current', 'page');
  const darkColor = await habitsTab.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).not.toBe('rgb(0, 0, 0)');
});

test('the navigation sits where its layout puts it: bottom bar on mobile, left sidebar on desktop', async ({
  page,
}, testInfo) => {
  await registerPasskey(page);

  const viewport = page.viewportSize();
  const navBox = await page.getByRole('navigation', { name: 'Hauptnavigation' }).boundingBox();
  const mainBox = await page.locator('main.shell__main').boundingBox();
  expect(viewport).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  if (testInfo.project.name === 'mobile') {
    // Bottom bar: its bottom edge reaches the viewport bottom, not sitting under the status bar,
    // with the content above it and no dead space at the top.
    expect(navBox!.y + navBox!.height).toBeGreaterThan(viewport!.height - 2);
    expect(mainBox!.y).toBeLessThan(navBox!.y);
    expect(mainBox!.y).toBeLessThan(viewport!.height / 2);
  } else {
    // Sidebar: full-height, hugging the left edge, with the content to its right.
    expect(navBox!.x).toBeLessThan(2);
    expect(navBox!.height).toBeGreaterThan(viewport!.height - 2);
    expect(mainBox!.x).toBeGreaterThan(navBox!.x + navBox!.width - 2);
  }
});
