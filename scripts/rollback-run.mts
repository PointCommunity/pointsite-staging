import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PublicationClient } from "./publication-client.mts";
import {
  RollbackInputSchema,
  restoreRollbackOutput,
} from "./rollback-output.mts";
import { outputManifest } from "./output-manifest.mts";
import { checkPublicationBrowser } from "./publication-browser.mts";
import { verifyPublicationOutputWithRetry } from "./publication-live.mts";

try {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.RUNNER_OS, "Linux");
  assert.equal(process.env.RUNNER_ARCH, "X64");
  assert.equal(process.version, "v22.23.2");
  const job = z.uuid().parse(process.env.PUBLICATION_JOB_ID);
  const nonce = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env.PUBLICATION_NONCE);
  const source = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.PUBLICATION_SOURCE);
  const root = process.cwd();
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    source,
  );
  const state = join(
    z.string().startsWith("/").parse(process.env.RUNNER_TEMP),
    `pointsite-rollback-${job}.json`,
  );
  const client = new PublicationClient(
    job,
    nonce,
    source,
    process.env,
    fetch,
    "rollback",
  );
  const operation = z
    .enum(["prepare", "authorize-pages", "verify-pages"])
    .parse(process.argv[2]);
  if (operation === "prepare") {
    await client.claim();
    const input = RollbackInputSchema.parse(await client.rollbackInputs());
    assert.equal(input.workflowRevision, source);
    const output = await restoreRollbackOutput(root, input);
    checkPublicationBrowser(root, output.artifactDigest, true);
    await writeFile(state, JSON.stringify(input), {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    const input = RollbackInputSchema.parse(
      JSON.parse(await readFile(state, "utf8")),
    );
    assert.equal(input.workflowRevision, source);
    const output = await outputManifest(join(root, "out"));
    assert.equal(output.artifactDigest, input.source.artifactDigest);
    assert.equal(output.totalBytes, input.source.totalBytes);
    assert.equal(output.files.length, input.source.fileCount);
    if (operation === "authorize-pages") await client.authorizeDeployment();
    else {
      await verifyPublicationOutputWithRetry({
        target: "production",
        ...output,
        candidateChecksum: input.candidateChecksum,
        workflowRevision: source,
      });
      await client.reportPagesDeployment(output.artifactDigest);
    }
  }
} catch {
  process.stderr.write(
    "Rollback did not complete. Builder retains this operation for reconciliation.\n",
  );
  process.exitCode = 1;
}
