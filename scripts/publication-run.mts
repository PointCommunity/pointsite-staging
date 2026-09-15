import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { PublicationClient } from "./publication-client.mts";
import { preparePublicationBuild } from "./publication-build.mts";
import {
  fetchPublicationBase,
  pushPublicationCommit,
} from "./publication-git.mts";
import { outputManifest } from "./output-manifest.mts";
import { verifyPublicationOutputWithRetry } from "./publication-live.mts";
import { checkPublicationBrowser } from "./publication-browser.mts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.strictObject({
  candidateChecksum: digest,
  commitSha: sha,
  treeSha: sha,
  manifestBlobSha: sha,
  artifactDigest: digest,
  fileCount: z.number().int().min(1).max(2000),
  totalBytes: z.number().int().min(1).max(100_000_000),
});

let stage = "runner-validation";
async function main() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RUNNER_OS !== "Linux" ||
    process.env.RUNNER_ARCH !== "X64" ||
    process.version !== "v22.23.2"
  )
    throw new Error("PUBLICATION_RUNNER_INVALID");
  const jobId = z.uuid().parse(process.env.PUBLICATION_JOB_ID);
  const nonce = digest.parse(process.env.PUBLICATION_NONCE);
  const source = sha.parse(process.env.PUBLICATION_SOURCE);
  const target = z
    .enum(["staging", "production"])
    .parse(process.env.PUBLICATION_TARGET);
  const temporary = z.string().startsWith("/").parse(process.env.RUNNER_TEMP);
  const stateFile = join(temporary, `pointsite-publication-${jobId}.json`);
  const root = process.cwd();
  const client = new PublicationClient(jobId, nonce, source);
  const operation = z
    .enum(["prepare", "authorize-pages", "verify-pages"])
    .parse(process.argv[2]);
  if (operation === "prepare") {
    stage = "claim";
    await client.claim();
    stage = "inputs";
    const input = await client.inputs();
    stage = "fetch-base";
    fetchPublicationBase(root, target, input.baseSha);
    stage = "build";
    const { build } = await preparePublicationBuild(
      root,
      jobId,
      source,
      input,
      (asset, index) => client.chunk(asset, index),
    );
    stage = "browser-verification";
    checkPublicationBrowser(root, build.artifactDigest);
    stage = "authorize-build";
    await client.authorizeBuild(build);
    stage = "push-candidate";
    pushPublicationCommit(
      root,
      target,
      jobId,
      build.commitSha,
      z.string().min(20).parse(process.env.GITHUB_TOKEN),
    );
    stage = "confirm-commit";
    await client.commitBuild(build.commitSha);
    stage = "save-receipt";
    await writeFile(stateFile, JSON.stringify(build), {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write("Publication commit confirmed.\n");
    return;
  }
  stage = "verify-local-output";
  const build = stateSchema.parse(
    JSON.parse(await readFile(stateFile, "utf8")),
  );
  const current = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (current !== source) throw new Error("PUBLICATION_CHECKOUT_CHANGED");
  const output = await outputManifest(join(root, "out"));
  if (
    output.artifactDigest !== build.artifactDigest ||
    output.totalBytes !== build.totalBytes ||
    output.files.length !== build.fileCount
  )
    throw new Error("PUBLICATION_OUTPUT_CHANGED");
  if (operation === "authorize-pages") {
    stage = "authorize-pages";
    await client.authorizeDeployment();
    return;
  }
  if (operation === "verify-pages") {
    stage = "verify-public-output";
    await verifyPublicationOutputWithRetry({
      target,
      ...output,
      candidateChecksum: build.candidateChecksum,
      workflowRevision: source,
    });
    stage = "report-deployment";
    await client.reportPagesDeployment(build.artifactDigest);
    process.stdout.write("Every public output file verified.\n");
    return;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch {
    // Never print provider bodies, child output, credentials, manifests or selected draft content.
    process.stderr.write(
      `Publication stopped at ${stage}. Builder retains this job for reconciliation.\n`,
    );
    process.exitCode = 1;
  }
}
