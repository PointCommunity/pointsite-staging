import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { defaultSiteDocument } from "../site-kit/default-site";
import { publicationMediaPaths } from "../site-kit/publication-media";
import { upgradeNavigation } from "../site-kit/migrations";
import { prunePublicationMedia } from "../scripts/prune-publication-media.mts";

for (const upgrade of [false, true])
test(`schema ${upgrade ? 10 : 9} publications retain required images and fonts and preserve source documents`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pointsite-used-images-"));
  try {
    const document = upgrade ? upgradeNavigation(defaultSiteDocument) : structuredClone(defaultSiteDocument);
    const navigation = document.navigationDesigns?.[0].items ?? document.navigation;
    navigation[0].href = "/assets/menu-download";
    assert.ok(publicationMediaPaths(document).includes("/assets/menu-download"));
    document.media.push({
      id: crypto.randomUUID(),
      sourcePath: "/assets/unused.png",
      alt: "Unused image",
    });
    const content = JSON.stringify(document);
    await mkdir(join(root, "content"));
    await writeFile(join(root, "content/builder-site.json"), content);
    const manifestPath = join(root, "content/builder-site.manifest.json");
    await writeFile(manifestPath, "{}");
    const paths = [
      ...publicationMediaPaths(document),
      "/assets/unused.png",
      "/assets/fonts/test.woff2",
    ];
    for (const path of paths) {
      const file = join(root, "out", path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "asset");
    }
    assert.equal(
      await prunePublicationMedia(root),
      0,
      "historical publications are unchanged",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ mediaSelection: "referenced" }),
    );
    assert.equal(await prunePublicationMedia(root), 1);
    assert.equal(
      await readFile(join(root, "content/builder-site.json"), "utf8"),
      content,
    );
    await assert.rejects(
      readFile(join(root, "out/assets/unused.png")),
      /ENOENT/,
    );
    for (const path of paths.filter((path) => path !== "/assets/unused.png"))
      assert.equal(await readFile(join(root, "out", path), "utf8"), "asset");
    await writeFile(join(root, "out/assets/unused.png"), "preserve on failure");
    await rm(join(root, "out", publicationMediaPaths(document)[0]));
    await assert.rejects(
      prunePublicationMedia(root),
      /referenced image is missing/,
    );
    assert.equal(
      await readFile(join(root, "out/assets/unused.png"), "utf8"),
      "preserve on failure",
    );
    await symlink(join(root, "content"), join(root, "out/assets/link"));
    await assert.rejects(prunePublicationMedia(root), /symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
