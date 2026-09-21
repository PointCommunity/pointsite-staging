import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyWorkflowPins(workflows: string[], remoteTags: string) {
  const tags = new Map(
    remoteTags.trim().split("\n").filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return [ref.replace(/\^\{\}$/, ""), sha];
    }),
  );
  let count = 0;
  for (const workflow of workflows) {
    for (const match of workflow.matchAll(
      /^\s+uses:\s*['"]?PointCommunity\/pointsite-staging\/(\.github\/workflows\/[^@\s]+)@([^\s'"]+)/gm,
    )) {
      const [, path, sha] = match;
      assert.match(sha, /^[a-f0-9]{40}$/, `${path} must pin a full commit SHA`);
      assert.equal(
        tags.get(`refs/tags/runtime/${sha}`),
        sha,
        `${path}@${sha} needs a matching protected runtime/${sha} tag before activation; PR branches may be deleted after squash merge`,
      );
      count++;
    }
  }
  assert.ok(count > 0, "No canonical reusable workflow pins found");
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = await Promise.all(
    (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file))
      .map((file) => readFile(new URL(file, directory), "utf8")),
  );
  const tags = execFileSync("git", [
    "ls-remote", "--tags", "https://github.com/PointCommunity/pointsite-staging.git",
    "refs/tags/runtime/*",
  ], { encoding: "utf8", timeout: 30_000 });
  console.log(`Verified ${verifyWorkflowPins(workflows, tags)} retained workflow pins.`);
}
