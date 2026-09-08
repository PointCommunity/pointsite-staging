import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  expectedCandidateChecksum,
  liveResponseDetail,
  liveRouteUrl,
  stagingProbeHeaders,
} from "../scripts/verify-staging.mts";
import { SiteDocumentSchema } from "../site-kit/schema";
import { RENDERER_IDENTITY } from "../site-kit/version";

test("published candidate matches the committed renderer contract", async () => {
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
    RENDERER_IDENTITY,
  );
  assert.equal(manifest.schemaVersion, RENDERER_IDENTITY.schemaVersion);
  assert.equal(manifest.rendererVersion, RENDERER_IDENTITY.rendererVersion);
  assert.doesNotThrow(() => SiteDocumentSchema.parse(document));
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
  assert.doesNotMatch(workflow, /run: npx wrangler deploy/);
});
