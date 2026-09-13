import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { outputManifest } from "../scripts/output-manifest.mts";

test("compares complete static bytes while ignoring time and the separate release attestation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pointsite-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(outputManifest(root), /INCOMPLETE/);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<p>Same candidate</p>");
  await writeFile(join(root, "assets/font.woff2"), "fixture bytes");
  const first = await outputManifest(root);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ["assets/font.woff2", "index.html"],
  );
  await writeFile(
    join(root, "__pointsite_release.json"),
    '{"target":"staging"}',
  );
  await utimes(join(root, "index.html"), new Date(0), new Date(0));
  assert.deepEqual(await outputManifest(root), first);
  await writeFile(join(root, "assets/font.woff2"), "changed bytes");
  assert.notEqual(
    (await outputManifest(root)).artifactDigest,
    first.artifactDigest,
  );
  await symlink(join(root, "index.html"), join(root, "linked.html"));
  await assert.rejects(outputManifest(root), /LINK_INVALID/);
  await rm(join(root, "linked.html"));
  await link(join(root, "index.html"), join(root, "linked.html"));
  await assert.rejects(outputManifest(root), /LINK_INVALID/);
});
