import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { preparePublicationCommit } from "../scripts/publication-git.mts";

test("creates repeatable candidate commits with one exact parent and only allowed input changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pointsite-git-"));
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
  await mkdir(join(root, "content"));
  await writeFile(join(root, "content/builder-site.json"), '{"before":true}');
  await writeFile(join(root, "content/builder-site.manifest.json"), "{}");
  await writeFile(join(root, "unrelated.txt"), "preserved");
  git("add", ".");
  git("commit", "-m", "Fixture");
  const baseSha = git("rev-parse", "HEAD");
  const originalIndex = git("ls-files", "--stage");
  await writeFile(join(root, "content/builder-site.json"), '{"after":true}');
  await writeFile(
    join(root, "content/builder-site.manifest.json"),
    '{"candidate":true}',
  );
  await writeFile(
    join(root, "unrelated.txt"),
    "uncommitted change must stay out",
  );
  await mkdir(join(root, "public/assets"), { recursive: true });
  await writeFile(
    join(root, "public/assets/image.png"),
    new Uint8Array([1, 2, 3]),
  );
  await writeFile(
    join(root, "content/builder-site.output.json"),
    '{"files":[]}',
  );
  const input = {
    jobId: randomUUID(),
    baseSha,
    requestedAt: "2026-09-13T00:00:00.000Z",
    files: [
      "content/builder-site.json",
      "content/builder-site.manifest.json",
      "content/builder-site.output.json",
      "public/assets/image.png",
    ],
  };
  const candidate = await preparePublicationCommit(root, input);
  assert.deepEqual(await preparePublicationCommit(root, input), candidate);
  assert.equal(git("rev-parse", `${candidate.commitSha}^`), baseSha);
  assert.equal(
    git("rev-parse", `${candidate.commitSha}^{tree}`),
    candidate.treeSha,
  );
  assert.equal(
    git("show", `${candidate.commitSha}:unrelated.txt`),
    "preserved",
  );
  assert.equal(
    git("show", `${candidate.commitSha}:content/builder-site.json`),
    '{"after":true}',
  );
  assert.equal(git("rev-parse", "HEAD"), baseSha);
  assert.equal(git("ls-files", "--stage"), originalIndex);
  assert.deepEqual(
    git("diff-tree", "--no-commit-id", "--name-only", "-r", candidate.commitSha)
      .split("\n")
      .sort(),
    input.files.sort(),
  );
  for (const path of [
    "../secret",
    ".github/workflows/deploy.yml",
    "public/assets/../../secret.png",
  ]) {
    await assert.rejects(
      preparePublicationCommit(root, {
        ...input,
        files: [...input.files, path],
      }),
    );
  }
});
