import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const routes = [
  "/",
  "/who-we-are",
  "/what-we-believe",
  "/leadership",
  "/next-generation",
  "/connect-card",
  "/neighborhood-groups",
  "/prayer-request",
  "/give",
  "/contact",
  "/building-rental",
];
const widths = [360, 768, 1280];
const productionOrigin = (
  process.env.PRODUCTION_URL ?? "https://pointatx.org"
).replace(/\/$/, "");
const stagingOrigin = "http://127.0.0.1:4174";

async function settle(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  expect(response?.ok(), url).toBe(true);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important} iframe,nextjs-portal{visibility:hidden!important}",
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.onload = () => resolve();
              image.onerror = () => resolve();
            }),
      ),
    );
  });
}

async function pixels(buffer: Buffer) {
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

test("matches every live production route at mobile, tablet, and desktop widths", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "One Chromium run covers all required widths.",
  );
  test.setTimeout(120_000);

  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const production = await context.newPage();
    const staging = await context.newPage();

    for (const route of routes) {
      await Promise.all([
        settle(production, `${productionOrigin}${route}`),
        settle(staging, `${stagingOrigin}${route}`),
      ]);
      const [expected, actual] = await Promise.all([
        pixels(await production.screenshot({ fullPage: true })),
        pixels(await staging.screenshot({ fullPage: true })),
      ]);

      expect(actual.info.width, `${width}px ${route} width`).toBe(
        expected.info.width,
      );
      expect(actual.info.height, `${width}px ${route} height`).toBe(
        expected.info.height,
      );
      let changedPixels = 0;
      for (let index = 0; index < expected.data.length; index += 4) {
        if (
          Math.abs(expected.data[index]! - actual.data[index]!) > 8 ||
          Math.abs(expected.data[index + 1]! - actual.data[index + 1]!) > 8 ||
          Math.abs(expected.data[index + 2]! - actual.data[index + 2]!) > 8
        ) {
          changedPixels += 1;
        }
      }
      const mismatchRate = changedPixels / (expected.data.length / 4);
      expect(
        mismatchRate,
        `${width}px ${route} visual mismatch`,
      ).toBeLessThanOrEqual(0.0002);
    }

    await context.close();
  }
});
