import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSiteDocument } from "../../site-kit/default-site";
import { outputManifest } from "../../scripts/output-manifest.mts";
import { verifyPublicationBrowser } from "../../scripts/publication-browser.mts";

test(
  "candidate browser checks render exported bytes and reject broken assets, layout, scripts and accessibility",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "pointsite-publication-browser-"),
    );
    try {
      await mkdir(join(root, "out"));
      await mkdir(join(root, "content"));
      const document = structuredClone(defaultSiteDocument);
      document.pages = document.pages.filter((page) => page.route === "/");
      await writeFile(
        join(root, "content/builder-site.json"),
        JSON.stringify(document),
      );
      for (const failure of [
        "",
        "asset",
        "layout",
        "script",
        "accessibility",
        "digest",
      ]) {
        await writeFile(
          join(root, "out/index.html"),
          `<!doctype html><html lang="en"><head><title>Fixture</title></head><body>
        <a href="#point-main">Skip to content</a><main id="point-main" tabindex="-1"><h1>Fixture</h1>
        <button aria-expanded="false" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded') !== 'true')">Menu</button>
        ${failure === "asset" ? '<script src="/outside-manifest.js"></script>' : ""}
        ${failure === "layout" ? '<div style="width:5000px">Overflow</div>' : ""}
        ${failure === "script" ? '<script>throw Error("private fixture error")</script>' : ""}
        ${failure === "accessibility" ? "<button></button>" : ""}
        <script src="https://external.invalid/blocked.js"></script></main></body></html>`,
        );
        const output = await outputManifest(join(root, "out"));
        if (failure) {
          await assert.rejects(
            verifyPublicationBrowser(
              root,
              failure === "digest" ? "a".repeat(64) : output.artifactDigest,
            ),
          );
        } else {
          const result = await verifyPublicationBrowser(
            root,
            output.artifactDigest,
          );
          assert.equal(result.checked, 3);
          assert.equal(result.routes, 1);
          assert.equal(result.blockedExternal, 3);
          assert.equal(result.artifactDigest, output.artifactDigest);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
