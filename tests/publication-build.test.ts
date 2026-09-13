import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSiteDocument } from "../site-kit/default-site";
import { checksumDocument } from "../site-kit/canonicalize";
import { preparePublicationBuild } from "../scripts/publication-build.mts";
import { outputManifest } from "../scripts/output-manifest.mts";

test("builds a captured candidate and refuses input substitution by the build subprocess", async (t) => {
  for (const tamper of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "pointsite-build-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    git("init", "--object-format=sha1");
    await writeFile(join(root, "README.md"), "Public build fixture");
    git("add", ".");
    git("commit", "-m", "Fixture");
    const source = git("rev-parse", "HEAD");
    const document = structuredClone(defaultSiteDocument);
    const bytes = new Uint8Array([1, 2, 3]);
    for (const media of document.media) media.sourcePath = "/assets/image.png";
    const assets = [
      {
        assetId: randomUUID(),
        sourcePath: "/assets/image.png",
        byteSize: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        contentType: "image/png",
      },
    ];
    const candidate = {
      siteId: "pointsite",
      draftId: randomUUID(),
      revisionId: randomUUID(),
      revisionChecksum: await checksumDocument(document),
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      publicationProtocol: 2,
      workflowRevision: source,
      fileCount: 3,
    };
    const input = {
      candidate,
      candidateChecksum: await checksumDocument({ ...candidate, assets }),
      document,
      assets,
      baseSha: source,
      requestedAt: "2026-09-13T00:00:00.000Z",
    };
    const runBuild = async (directory: string, buildId: string) => {
      assert.equal(
        buildId,
        await checksumDocument({
          candidateChecksum: input.candidateChecksum,
          workflowRevision: source,
        }),
      );
      if (tamper) {
        await writeFile(join(directory, "content/builder-site.json"), "{}");
        return;
      }
      for (const page of document.pages.filter(
        (page) => page.status !== "hidden",
      )) {
        const folder = join(directory, "out", page.route);
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, "index.html"),
          '<html lang="en"><a href="#point-main">Skip</a><main id="point-main"><h1>Fixture</h1></main></html>',
        );
      }
    };
    const pending = preparePublicationBuild(
      root,
      randomUUID(),
      source,
      input,
      async () => bytes,
      runBuild,
    );
    if (tamper) {
      await assert.rejects(pending, /PUBLICATION_INPUT_CHANGED/);
      continue;
    }
    const result = await pending;
    assert.deepEqual(await outputManifest(join(root, "out")), result.output);
    assert.equal(result.build.candidateChecksum, input.candidateChecksum);
    assert.equal(
      git(
        "rev-parse",
        `${result.build.commitSha}:content/builder-site.output.json`,
      ),
      result.build.manifestBlobSha,
    );
    assert.equal(git("rev-parse", `${result.build.commitSha}^`), source);
    assert.equal(git("rev-parse", "HEAD"), source);
    const release = JSON.parse(
      await readFile(join(root, "out/__pointsite_release.json"), "utf8"),
    );
    assert.equal(release.artifactDigest, result.output.artifactDigest);
    assert.equal(
      git("show", `${result.build.commitSha}:README.md`),
      "Public build fixture",
    );
  }
});
