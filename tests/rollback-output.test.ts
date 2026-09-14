import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { outputManifest } from "../scripts/output-manifest.mts";
import { restoreRollbackOutput } from "../scripts/rollback-output.mts";

test("restores exact baseline bytes, rejects archive substitution, and never follows archive links", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pointsite-rollback-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const original = join(temporary, "original");
  await mkdir(original);
  await writeFile(
    join(original, "index.html"),
    '<html><main id="point-main"><h1>Retained website</h1></main></html>',
  );
  const output = await outputManifest(original);
  const blob = (bytes: Uint8Array) =>
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
  for (const mode of ["valid", "tampered", "symlink", "traversal"]) {
    const root = join(temporary, mode);
    await mkdir(root);
    const archivePath = join(root, "site.tar.gz");
    execFileSync("python3", [
      "-c",
      String.raw`
import sys,tarfile
with tarfile.open(sys.argv[2],'w:gz') as archive:
    archive.add(sys.argv[1]+'/index.html',arcname='index.html')
    if sys.argv[3] in ['symlink','traversal']:
        member=tarfile.TarInfo('escape' if sys.argv[3]=='symlink' else '../escape')
        member.type=tarfile.SYMTYPE if sys.argv[3]=='symlink' else tarfile.REGTYPE
        member.linkname='/tmp/pointsite-unowned'
        archive.addfile(member)
`,
      original,
      archivePath,
      mode,
    ]);
    const archive = await readFile(archivePath);
    const manifest = Buffer.from(
      JSON.stringify({ ...output, sourceRevision: "a".repeat(40) }),
    );
    const input = {
      candidateChecksum: "b".repeat(64),
      baseSha: "c".repeat(40),
      workflowRevision: "d".repeat(40),
      source: {
        kind: "baseline",
        sourceRevision: "a".repeat(40),
        artifactDigest: output.artifactDigest,
        fileCount: output.files.length,
        totalBytes: output.totalBytes,
        archiveRevision: "e".repeat(40),
        archivePath: "publication-baseline/site.tar.gz",
        archiveBlobSha: blob(archive),
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
        archiveBytes: archive.length,
        manifestPath: "publication-baseline/manifest.json",
        manifestBlobSha: blob(manifest),
      },
    };
    const fetcher: typeof fetch = async (url) =>
      new Response(
        String(url).endsWith(".json")
          ? manifest
          : mode === "tampered"
            ? Buffer.from("altered")
            : archive,
      );
    const pending = restoreRollbackOutput(root, input, fetcher);
    if (mode !== "valid") {
      await assert.rejects(pending, /ROLLBACK_OUTPUT_UNCONFIRMED/);
      continue;
    }
    assert.deepEqual(await pending, output);
    assert.deepEqual(await outputManifest(join(root, "out")), output);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(root, "out/__pointsite_release.json"), "utf8"),
      ),
      {
        format: 2,
        candidateChecksum: input.candidateChecksum,
        artifactDigest: output.artifactDigest,
        workflowRevision: input.workflowRevision,
        sourceCommit: input.source.sourceRevision,
      },
    );
    await assert.rejects(
      restoreRollbackOutput(root, input, fetcher),
      /ROLLBACK_OUTPUT_UNCONFIRMED/,
    );
  }
});
