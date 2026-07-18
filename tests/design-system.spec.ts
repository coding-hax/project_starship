import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
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
