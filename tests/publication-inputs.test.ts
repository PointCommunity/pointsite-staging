import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSiteDocument } from "../site-kit/default-site";
import { checksumDocument } from "../site-kit/canonicalize";
import {
  materializePublication,
  validatePublicationInputs,
} from "../scripts/publication-inputs.mts";
import { expectedCandidateChecksum } from "../scripts/verify-staging.mts";

async function fixture() {
  const document = structuredClone(defaultSiteDocument);
  const assetId = randomUUID();
  const draftId = randomUUID();
  const sourcePath = `/assets/builder/${draftId}/${assetId}/image.png`;
  for (const media of document.media) media.sourcePath = sourcePath;
  const bytes = new Uint8Array(1_000_001).fill(42);
  const assets = [
    {
      assetId,
      sourcePath,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      contentType: "image/png" as const,
    },
  ];
  const candidate = {
    siteId: "pointsite" as const,
    draftId,
    revisionId: randomUUID(),
    revisionChecksum: await checksumDocument(document),
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    publicationProtocol: 2 as const,
    workflowRevision: "a".repeat(40),
    fileCount: 3,
  };
  const input = {
    candidate,
    candidateChecksum: await checksumDocument({ ...candidate, assets }),
    document,
    assets,
    baseSha: "b".repeat(40),
    requestedAt: new Date().toISOString(),
  };
  return { input, bytes };
}

test("materializes only the exact validated inputs and verifies each complete image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pointsite-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { input, bytes } = await fixture();
  assert.deepEqual(
    await validatePublicationInputs(input, "a".repeat(40)),
    input,
  );
  const requests: number[] = [];
  const files = await materializePublication(
    root,
    input,
    "a".repeat(40),
    async (id, index) => {
      assert.equal(id, input.assets[0].assetId);
      requests.push(index);
      return bytes.slice(index * 1_000_000, (index + 1) * 1_000_000);
    },
  );
  assert.deepEqual(requests, [0, 1]);
  assert.equal(files.length, 3);
  assert.deepEqual(
    await readFile(join(root, `public${input.assets[0].sourcePath}`)),
    Buffer.from(bytes),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "content/builder-site.json"), "utf8")),
    input.document,
  );
  const manifest = JSON.parse(
    await readFile(join(root, "content/builder-site.manifest.json"), "utf8"),
  );
  assert.equal(manifest.candidateChecksum, input.candidateChecksum);
  assert.deepEqual(manifest.assets, input.assets);
  const content = await readFile(
    join(root, "content/builder-site.json"),
    "utf8",
  );
  const media = [
    {
      path: `public${input.assets[0].sourcePath}`,
      encoded: Buffer.from(bytes).toString("base64"),
    },
  ];
  assert.equal(
    await expectedCandidateChecksum(content, manifest, media),
    input.candidateChecksum,
  );
  await assert.rejects(
    expectedCandidateChecksum(content, manifest, [
      { ...media[0], encoded: "YQ==" },
    ]),
    /ASSET_MISMATCH/,
  );
});

test("rejects source, candidate, path, manifest and byte substitution before accepting files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pointsite-publication-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { input, bytes } = await fixture();
  await assert.rejects(validatePublicationInputs(input, "c".repeat(40)));
  for (const change of [
    { candidateChecksum: "c".repeat(64) },
    { candidate: { ...input.candidate, revisionId: randomUUID() } },
    { assets: [] },
    {
      assets: [{ ...input.assets[0], sourcePath: "/assets/../../secrets.png" }],
    },
    { assets: [{ ...input.assets[0], checksum: "c".repeat(64) }] },
    { document: { ...input.document, media: [] } },
  ])
    await assert.rejects(
      validatePublicationInputs({ ...input, ...change }, "a".repeat(40)),
    );
  await assert.rejects(
    materializePublication(
      root,
      input,
      "a".repeat(40),
      async () => new Uint8Array(),
    ),
    /SIZE_MISMATCH/,
  );
  await assert.rejects(
    materializePublication(root, input, "a".repeat(40), async (_, index) =>
      bytes.slice(index * 1_000_000, (index + 1) * 1_000_000).fill(13),
    ),
    /CHECKSUM_MISMATCH/,
  );
  assert.deepEqual(await readdir(root), []);
  const outside = await mkdtemp(
    join(tmpdir(), "pointsite-publication-outside-"),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "public"));
  await assert.rejects(
    materializePublication(root, input, "a".repeat(40), async (_, index) =>
      bytes.slice(index * 1_000_000, (index + 1) * 1_000_000),
    ),
    /PATH_INVALID/,
  );
  assert.deepEqual(await readdir(outside), []);
});
