import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

/**
 * Design-system rules that hold app-wide. The header↔content rhythm (#85) is the
 * first: the gap under a heading comes from the spacing scale, never ad hoc.
 */
test.describe('Design-System: Heading↔Content-Abstand', () => {
  test('der Seitentitel h1 hält den Token-Abstand (--space-6 = 24px) zum Inhalt', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const h1 = page.getByRole('heading', { level: 1, name: 'Aufgaben' });
    await expect(h1).toBeVisible();

    const marginBottom = await h1.evaluate((el) => getComputedStyle(el).marginBottom);
    expect(marginBottom).toBe('24px');
  });
});

test.describe('Design-System: FAB-Glyphengröße', () => {
  test('FAB-Icon hat 34px font-size (AC1)', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fabIcon = page.locator('.fab__icon');
    const fontSize = await fabIcon.evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontSize).toBe('34px');
  });

  test('FAB-Button ist exakt 56×56px (AC2)', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const bbox = await fab.boundingBox();
    expect(bbox?.width).toBe(56);
    expect(bbox?.height).toBe(56);
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons (AC4) — 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons (AC4) — 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1024 });
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons auch auf /gewohnheiten (geteilt)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await registerPasskey(page);
    await page.goto('/gewohnheiten');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });
});
