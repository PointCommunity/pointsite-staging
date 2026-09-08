import { expect, test, type Page } from "@playwright/test";

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

test("preserves production route and responsive-layout coverage for staged candidates", async ({
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
      await expect(
        production.getByRole("main"),
        `${width}px ${route} production main`,
      ).toBeVisible();
      await expect(
        staging.getByRole("main"),
        `${width}px ${route} staging main`,
      ).toBeVisible();
      expect(
        await staging.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${width}px ${route} staging overflow`,
      ).toBe(true);
    }

    await context.close();
  }
});
