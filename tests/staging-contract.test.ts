import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  accessServiceHeaders,
  expectedCandidateChecksum,
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

test("builds Access service headers only from a complete credential pair", () => {
  assert.deepEqual(
    accessServiceHeaders({
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    }),
    {
      "CF-Access-Client-Id": "client-id",
      "CF-Access-Client-Secret": "client-secret",
    },
  );
  assert.throws(
    () => accessServiceHeaders({ CF_ACCESS_CLIENT_ID: "client-id" }),
    /complete Cloudflare Access service credential pair/,
  );
  assert.throws(
    () => accessServiceHeaders({}),
    /complete Cloudflare Access service credential pair/,
  );
});
