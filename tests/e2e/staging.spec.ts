import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const routes = [
  '/',
  '/who-we-are',
  '/what-we-believe',
  '/leadership',
  '/next-generation',
  '/connect-card',
  '/neighborhood-groups',
  '/prayer-request',
  '/give',
  '/contact',
  '/building-rental',
];

for (const route of routes) {
  test(`${route} renders semantic, accessible static content`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);
    await expect(page.locator('main#point-main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
      ['critical', 'serious'].includes(item.impact ?? ''),
    );
    expect(serious).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  });
}

test('primary navigation reaches a second generated page without client-only data', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'About', exact: true })
    .click();
  await expect(page).toHaveURL(/\/who-we-are\/?$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
