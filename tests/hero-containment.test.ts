import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSiteDocument } from "../site-kit/default-site";
import { renderSection } from "../site-kit/registry";

test("legacy Flow sections retain their single-column composition", () => {
  const document = structuredClone(defaultSiteDocument);
  const section = document.pages[0].blocks[0];
  section.layout = "flow";
  section.columns = 3;
  assert.match(renderToStaticMarkup(renderSection(section, document)), /--point-section-columns:1;/);
  document.schemaVersion = 11;
  document.rendererVersion = "11.0.0";
  document.footer = [];
  assert.match(renderToStaticMarkup(renderSection(section, document)), /--point-section-columns:3;/);
});

test("published compatibility page heroes retain the editor clipping wrapper", () => {
  const page = defaultSiteDocument.pages.find((page) => page.route === "/who-we-are")!;
  const section = page.blocks.find((section) => section.name === "Page hero")!;
  for (const surface of ["primary", "image", "canvas"] as const) {
    const candidate = structuredClone(section);
    const hero = candidate.items[0].element;
    assert.equal(hero.type, "hero");
    if (hero.type !== "hero") throw new Error("Expected page Hero");
    hero.surface = surface;
    const html = renderToStaticMarkup(renderSection(candidate, defaultSiteDocument));
    assert.match(html, /<div class="point-layout-item point-layout-item--grid"[^>]*><section class="page-hero /);
    assert.match(html, /Who We Are/);
  }
});
