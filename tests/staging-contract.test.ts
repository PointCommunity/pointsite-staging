import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  expectedCandidateChecksum,
  liveResponseDetail,
  liveRouteUrl,
  stagingProbeHeaders,
  verifyStagingWithRetry,
} from "../scripts/verify-staging.mts";
import { migrateDocument } from "../site-kit/migrations";
import { RENDERER_IDENTITY } from "../site-kit/version";

test("published candidate migrates into the committed renderer contract", async () => {
  const document = JSON.parse(
    await readFile("content/builder-site.json", "utf8"),
  ) as { schemaVersion: number; rendererVersion: string };
  const manifest = JSON.parse(
    await readFile("content/builder-site.manifest.json", "utf8"),
  ) as { schemaVersion: number; rendererVersion: string };

  assert.deepEqual(
    {
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
    },
    {
      schemaVersion: manifest.schemaVersion,
      rendererVersion: manifest.rendererVersion,
    },
  );
  const migrated = migrateDocument(document);
  assert.deepEqual(
    {
      schemaVersion: migrated.document.schemaVersion,
      rendererVersion: migrated.document.rendererVersion,
    },
    RENDERER_IDENTITY,
  );
  assert.deepEqual(migrated.applied, ["8-to-9"]);
  assert.deepEqual(migrateDocument(migrated.document).applied, []);
});

test("verifies the published candidate checksum including referenced media", async () => {
  const content = await readFile("content/builder-site.json", "utf8");
  const document = JSON.parse(content) as {
    media: Array<{ sourcePath: string }>;
  };
  const manifest = JSON.parse(
    await readFile("content/builder-site.manifest.json", "utf8"),
  ) as {
    rendererVersion: string;
    source: string;
    sha256?: string;
    candidateChecksum?: string;
  };
  const media = await Promise.all(
    document.media
      .filter((item) => item.sourcePath.startsWith("/assets/builder/"))
      .map(async (item) => ({
        path: `public${item.sourcePath}`,
        encoded: Buffer.from(
          await readFile(`public${item.sourcePath}`),
        ).toString("base64"),
      })),
  );
  const observed = await expectedCandidateChecksum(content, manifest, media);
  assert.equal(observed, manifest.candidateChecksum ?? manifest.sha256);
  assert.notEqual(observed, "0".repeat(64));
});

test("reports safe edge diagnostics without exposing request credentials", async () => {
  const response = new Response("edge denied", {
    status: 403,
    headers: {
      "cf-mitigated": "challenge",
      "content-type": "text/plain",
      server: "cloudflare",
    },
  });
  assert.equal(
    await liveResponseDetail(response),
    '403; security headers missing; cf-mitigated=challenge; server=cloudflare; content-type=text/plain; body="edge denied"',
  );
});

test("builds a staging-only probe header only from an explicit secret", () => {
  assert.deepEqual(
    stagingProbeHeaders({
      STAGING_PROBE_SECRET: "probe-secret-at-least-32-characters",
    }),
    { "X-PointSite-Staging-Probe": "probe-secret-at-least-32-characters" },
  );
  assert.throws(() => stagingProbeHeaders({}), /staging probe secret/i);
});

test("probes canonical trailing-slash route URLs without redirects", () => {
  assert.equal(
    liveRouteUrl("https://staging.pointatx.org", "/"),
    "https://staging.pointatx.org/",
  );
  assert.equal(
    liveRouteUrl("https://staging.pointatx.org/", "/who-we-are"),
    "https://staging.pointatx.org/who-we-are/",
  );
});

test("retries live verification without redeploying until routes converge", async () => {
  let attempts = 0;
  const slept: number[] = [];
  const evidence = await verifyStagingWithRetry(
    async () => {
      attempts += 1;
      return { ok: attempts === 3 } as Awaited<
        ReturnType<typeof import("../scripts/verify-staging.mts").verifyStaging>
      >;
    },
    [5_000, 15_000, 30_000],
    async (milliseconds) => {
      slept.push(milliseconds);
    },
  );
  assert.equal(evidence.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(slept, [5_000, 15_000]);
});

test("pins the PointSite account and exposes only the authenticated CI route", async () => {
  const config = await readFile("wrangler.jsonc", "utf8");
  assert.match(config, /"account_id": "bc890091d86ddf9ce669e96e79d47746"/);
  assert.match(config, /"workers_dev": true/);
  assert.match(config, /"preview_urls": false/);
  assert.match(config, /"pattern": "staging\.pointatx\.org"/);
  assert.match(config, /"custom_domain": true/);
  assert.match(config, /"run_worker_first": true/);
  assert.match(config, /"main": "\.\/worker\/index\.ts"/);
  assert.doesNotMatch(config, /cloudflareaccess|r2_buckets/i);
});

test("deploys through the idempotent exact-commit coordinator", async () => {
  const workflow = await readFile(
    ".github/workflows/deploy-staging.yml",
    "utf8",
  );
  assert.match(workflow, /npx tsx scripts\/deploy-staging\.mts/);
  assert.match(workflow, /GITHUB_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /STAGING_VERIFY_RETRY_SECONDS: 5,15,30,60/);
  assert.doesNotMatch(workflow, /run: npx wrangler deploy/);
});

test("names validation and deployment runs by purpose and trigger context", async () => {
  const [qualityWorkflow, deployWorkflow] = await Promise.all([
    readFile(".github/workflows/quality.yml", "utf8"),
    readFile(".github/workflows/deploy-staging.yml", "utf8"),
  ]);

  assert.match(
    qualityWorkflow,
    /^run-name: \$\{\{ github\.event_name == 'pull_request' && format\('Validate Staging PR \{0\} - \{1\}', github\.event\.pull_request\.number, github\.event\.pull_request\.title\) \|\| format\('Validate Staging candidate - \{0\}', github\.event\.head_commit\.message\) \}\}$/m,
  );
  assert.match(
    deployWorkflow,
    /^run-name: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('Deploy Staging manually from \{0\}', github\.ref_name\) \|\| format\('Deploy Staging candidate - \{0\}', github\.event\.head_commit\.message\) \}\}$/m,
  );
  assert.doesNotMatch(qualityWorkflow, /^run-name: .*Deploy Staging/m);
  assert.doesNotMatch(deployWorkflow, /^run-name: .*Validate Staging/m);
});
