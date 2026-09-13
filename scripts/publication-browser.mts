import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { migrateDocument } from "../site-kit/migrations";
import { outputManifest } from "./output-manifest.mts";

/** The browser and its Node parent receive no publication credentials. */
export function checkPublicationBrowser(root: string, artifactDigest: string) {
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/publication-browser.mts", artifactDigest],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
          CI: "true",
          NODE_ENV: "production",
        },
        timeout: 10 * 60_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("PUBLICATION_BROWSER_VERIFICATION_FAILED");
  }
}

export async function verifyPublicationBrowser(
  root: string,
  artifactDigest: string,
) {
  const output = await outputManifest(join(root, "out"));
  assert.equal(output.artifactDigest, artifactDigest);
  const files = new Set(output.files.map((file) => file.path));
  const { document: siteDocument } = migrateDocument(
    JSON.parse(await readFile(join(root, "content/builder-site.json"), "utf8")),
  );
  const routes = siteDocument.pages
    .filter((page) => page.status !== "hidden")
    .map((page) => page.route);
  const origin = "https://publication.invalid";
  const browser = await chromium.launch();
  let checked = 0;
  let blockedExternal = 0;
  try {
    for (const width of [360, 768, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      try {
        let missing = false;
        // Render the exact exported files. No HTTP request, form submission or third-party script reaches the network.
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== origin) {
            blockedExternal++;
            await route.abort();
            return;
          }
          const path = decodeURIComponent(url.pathname).slice(1);
          const file = files.has(path)
            ? path
            : path
              ? `${path.replace(/\/$/, "")}/index.html`
              : "index.html";
          if (request.method() !== "GET" || !files.has(file)) {
            missing = true;
            await route.fulfill({ status: 404, body: "" });
            return;
          }
          await route.fulfill({ path: join(root, "out", file) });
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        let scriptError = false;
        page.on("pageerror", () => {
          scriptError = true;
        });
        for (const route of routes) {
          assert.ok((await page.goto(`${origin}${route}`))?.ok());
          await page.evaluate(async () => {
            for (const image of document.images) image.loading = "eager";
            await document.fonts.ready;
          });
          await page.waitForFunction(() =>
            [...document.images].every(
              (image) => image.complete && image.naturalWidth > 0,
            ),
          );
          assert.ok(await page.locator("main#point-main").isVisible());
          assert.ok(
            await page.getByRole("heading", { level: 1 }).first().isVisible(),
          );
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          );
          for (const menu of await page
            .getByRole("button", { name: "Menu", exact: true })
            .all()) {
            if (!(await menu.isVisible())) continue;
            await menu.focus();
            await menu.press("Enter");
            await page.waitForFunction(() =>
              document.querySelector('button[aria-expanded="true"]'),
            );
            assert.equal(await menu.getAttribute("aria-expanded"), "true");
            await menu.press("Enter");
          }
          const skip = page.locator('a[href="#point-main"]').first();
          await skip.focus();
          await skip.press("Enter");
          assert.equal(new URL(page.url()).hash, "#point-main");
          const violations = (await new AxeBuilder({ page }).analyze())
            .violations;
          assert.equal(
            violations.filter((item) =>
              ["serious", "critical"].includes(item.impact ?? ""),
            ).length,
            0,
          );
          assert.equal(missing || scriptError, false);
          checked++;
        }
      } finally {
        await context.close();
      }
    }
    assert.equal(
      (await outputManifest(join(root, "out"))).artifactDigest,
      artifactDigest,
    );
    return {
      routes: routes.length,
      viewports: 3,
      checked,
      blockedExternal,
      artifactDigest,
    };
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await verifyPublicationBrowser(process.cwd(), process.argv[2]))}\n`,
    );
  } catch {
    // Assertions and browser errors can contain selected draft text. Emit only the fixed failure code.
    process.stderr.write("PUBLICATION_BROWSER_VERIFICATION_FAILED\n");
    process.exitCode = 1;
  }
}
