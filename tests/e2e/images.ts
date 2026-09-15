import type { Page } from "@playwright/test";

export async function loadImages(page: Page) {
  await page.locator("img").evaluateAll(async (elements) => {
    await Promise.all(elements.map(async (element) => {
      const image = element as HTMLImageElement;
      // Offscreen lazy images must be requested before checking their decoded size.
      image.loading = "eager";
      await image.decode();
    }));
  });
}
