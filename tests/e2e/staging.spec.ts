import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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

for (const route of routes) {
  test(`${route} renders semantic, accessible static content`, async ({
    page,
  }) => {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);
    await expect(page.locator("main#point-main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.locator("img").evaluateAll((images) =>
        images.map((image) => ({
          src: image.getAttribute("src"),
          width: (image as HTMLImageElement).naturalWidth,
        })),
      ),
    ).not.toContainEqual(expect.objectContaining({ width: 0 }));
    const serious = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((item) =>
      ["critical", "serious"].includes(item.impact ?? ""),
    );
    expect(serious).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    if (route !== "/") {
      expect(
        await page.locator(".page-hero").evaluate((hero) => {
          const heroBounds = hero.getBoundingClientRect();
          return Array.from(
            hero.querySelectorAll<HTMLElement>(".point-hero-text-box"),
          ).every((box) => {
            const boxBounds = box.getBoundingClientRect();
            return (
              boxBounds.left >= heroBounds.left - 1 &&
              boxBounds.right <= heroBounds.right + 1
            );
          });
        }),
      ).toBe(true);
    }
  });
}

test("primary navigation reaches a second generated page without client-only data", async ({
  page,
}) => {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1280) < 760) {
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  }
  await page
    .locator('section[aria-label="Site header"]')
    .getByRole("navigation")
    .getByRole("link", { name: "About", exact: true })
    .click();
  await expect(page).toHaveURL(/\/who-we-are\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

for (const route of [
  "/what-we-believe",
  "/next-generation",
  "/connect-card",
  "/neighborhood-groups",
  "/prayer-request",
  "/give",
  "/contact",
  "/building-rental",
]) {
  test(`${route} form validates and assembles a reviewable email request`, async ({
    page,
  }) => {
    await page.goto(route);
    const form = page.locator(".managed-form");
    for (const input of await form.locator("input[required]").all()) {
      const type = await input.getAttribute("type");
      if (type === "radio") {
        const name = await input.getAttribute("name");
        const selected = form
          .locator(`input[type="radio"][name="${name}"]`)
          .first();
        if (!(await selected.isChecked())) await selected.check();
      } else if (type === "email") {
        await input.fill("acceptance@example.com");
      } else {
        await input.fill("Acceptance test");
      }
    }
    for (const area of await form.locator("textarea[required]").all()) {
      await area.fill("Acceptance test message");
    }
    for (const select of await form.locator("select[required]").all()) {
      await select.selectOption({ index: 1 });
    }
    await form.getByRole("button").click();
    await expect(form.getByRole("status")).toHaveText(
      "Your email app is opening with this request ready to send.",
    );
  });
}

test("FAQ controls and external destination links remain functional", async ({
  page,
}) => {
  await page.goto("/neighborhood-groups");
  const firstQuestion = page.locator(".faq-section details").first();
  await expect(firstQuestion).not.toHaveAttribute("open");
  await firstQuestion.locator("summary").click();
  await expect(firstQuestion).toHaveAttribute("open", "");

  await page.goto("/give");
  await expect(
    page.getByRole("link", { name: "Open secure giving" }),
  ).toHaveAttribute("href", "https://subsplash.com/u/-W69J2R/give");
  await expect(
    page.getByRole("link", { name: "Point ATX on Facebook" }),
  ).toHaveAttribute("rel", "noreferrer");
});
