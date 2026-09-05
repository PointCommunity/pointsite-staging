import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  expectedCandidateChecksum,
  liveRouteUrl,
  stagingProbeHeaders,
} from "../scripts/verify-staging.mts";

test("rejects a deliberately corrupted baseline checksum", async () => {
  const content = await readFile("content/builder-site.json", "utf8");
  const manifest = JSON.parse(
    await readFile("content/builder-site.manifest.json", "utf8"),
  ) as { rendererVersion: string; source: string; sha256: string };
  const observed = await expectedCandidateChecksum(content, manifest);
  assert.equal(observed, manifest.sha256);
  assert.notEqual(observed, "0".repeat(64));
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

test("pins the PointSite account and disables every workers.dev route", async () => {
  const config = await readFile("wrangler.jsonc", "utf8");
  assert.match(config, /"account_id": "bc890091d86ddf9ce669e96e79d47746"/);
  assert.match(config, /"workers_dev": false/);
  assert.match(config, /"preview_urls": false/);
  assert.match(config, /"pattern": "staging\.pointatx\.org"/);
  assert.match(config, /"custom_domain": true/);
  assert.match(config, /"run_worker_first": true/);
  assert.match(config, /"main": "\.\/worker\/index\.ts"/);
  assert.doesNotMatch(config, /cloudflareaccess|r2_buckets/i);
});
