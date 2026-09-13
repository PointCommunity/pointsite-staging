import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checksumDocument } from "../site-kit/canonicalize";
import { SiteDocumentSchema } from "../site-kit/schema";
import { RENDERER_IDENTITY } from "../site-kit/version";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const assetSchema = z.strictObject({
  assetId: z.uuid(),
  sourcePath: z
    .string()
    .regex(
      /^\/assets\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp)$/,
    ),
  checksum: digest,
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
});
const candidateInputSchema = z.strictObject({
  candidate: z.strictObject({
    siteId: z.literal("pointsite"),
    draftId: z.uuid(),
    revisionId: z.uuid(),
    revisionChecksum: digest,
    schemaVersion: z.literal(RENDERER_IDENTITY.schemaVersion),
    rendererVersion: z.literal(RENDERER_IDENTITY.rendererVersion),
    publicationProtocol: z.literal(2),
    workflowRevision: revision,
    fileCount: z.number().int().min(2).max(502),
  }),
  candidateChecksum: digest,
  document: SiteDocumentSchema,
  assets: z.array(assetSchema).max(500),
});
const inputSchema = candidateInputSchema.extend({
  baseSha: revision,
  requestedAt: z.iso.datetime(),
});
export type PublicationInputs = z.infer<typeof inputSchema>;

export async function validatePublicationCandidate(
  value: unknown,
  workflowRevision: string,
) {
  const input = candidateInputSchema.parse(value);
  const paths = [
    ...new Set(input.document.media.map((item) => item.sourcePath)),
  ].sort();
  if (
    input.candidate.workflowRevision !== revision.parse(workflowRevision) ||
    input.document.schemaVersion !== input.candidate.schemaVersion ||
    input.document.rendererVersion !== input.candidate.rendererVersion ||
    (await checksumDocument(input.document)) !==
      input.candidate.revisionChecksum ||
    (await checksumDocument({ ...input.candidate, assets: input.assets })) !==
      input.candidateChecksum ||
    input.candidate.fileCount !== input.assets.length + 2 ||
    input.assets.length !== paths.length ||
    input.assets.some((asset, index) => asset.sourcePath !== paths[index]) ||
    new Set(input.assets.map((asset) => asset.assetId)).size !==
      input.assets.length ||
    input.assets.reduce((size, asset) => size + asset.byteSize, 0) >
      20 * 1024 * 1024
  )
    throw new Error("PUBLICATION_INPUT_MISMATCH");
  return input;
}

export async function validatePublicationInputs(
  value: unknown,
  workflowRevision: string,
): Promise<PublicationInputs> {
  const input = inputSchema.parse(value);
  await validatePublicationCandidate(
    {
      candidate: input.candidate,
      candidateChecksum: input.candidateChecksum,
      document: input.document,
      assets: input.assets,
    },
    workflowRevision,
  );
  return input;
}

export async function publicationManifestChecksum(
  content: string,
  value: unknown,
  media: { path: string; encoded: string }[],
) {
  const manifest = candidateInputSchema.shape.candidate
    .extend({
      candidateChecksum: digest,
      assets: candidateInputSchema.shape.assets,
      source: z.literal("PointCommunity/pointsite-builder"),
    })
    .parse(value);
  const candidate = candidateInputSchema.shape.candidate
    .strip()
    .parse(manifest);
  const input = await validatePublicationCandidate(
    {
      candidate,
      candidateChecksum: manifest.candidateChecksum,
      document: JSON.parse(content),
      assets: manifest.assets,
    },
    manifest.workflowRevision,
  );
  const byPath = new Map(media.map((file) => [file.path, file.encoded]));
  if (media.length !== input.assets.length || byPath.size !== media.length)
    throw new Error("PUBLICATION_ASSET_MISMATCH");
  for (const asset of input.assets) {
    const encoded = byPath.get(`public${asset.sourcePath}`);
    if (encoded === undefined) throw new Error("PUBLICATION_ASSET_MISMATCH");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length !== asset.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== asset.checksum
    )
      throw new Error("PUBLICATION_ASSET_MISMATCH");
  }
  return input.candidateChecksum;
}

/** Materialize into a fresh input directory; overlay the build checkout only after success. */
export async function materializePublication(
  root: string,
  value: unknown,
  workflowRevision: string,
  readChunk: (assetId: string, index: number) => Promise<Uint8Array>,
): Promise<string[]> {
  const input = await validatePublicationInputs(value, workflowRevision);
  const directory = await realpath(root);
  const paths: string[] = [];
  const write = async (path: string, bytes: string | Uint8Array) => {
    const target = resolve(directory, path);
    let parent = directory;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(parent)).isDirectory())
        throw new Error("PUBLICATION_PATH_INVALID");
    }
    // Exclusive files prevent a checked-out symlink or an old asset from being followed.
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    paths.push(path);
  };
  for (const asset of input.assets) {
    const bytes = new Uint8Array(asset.byteSize);
    for (
      let offset = 0, index = 0;
      offset < bytes.length;
      offset += 1_000_000, index++
    ) {
      const chunk = await readChunk(asset.assetId, index);
      if (chunk.length !== Math.min(1_000_000, bytes.length - offset))
        throw new Error("PUBLICATION_ASSET_SIZE_MISMATCH");
      bytes.set(chunk, offset);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum)
      throw new Error("PUBLICATION_ASSET_CHECKSUM_MISMATCH");
    await write(`public${asset.sourcePath}`, bytes);
  }
  await write(
    "content/builder-site.json",
    `${JSON.stringify(input.document, null, 2)}\n`,
  );
  await write(
    "content/builder-site.manifest.json",
    `${JSON.stringify(
      {
        ...input.candidate,
        candidateChecksum: input.candidateChecksum,
        assets: input.assets,
        source: "PointCommunity/pointsite-builder",
      },
      null,
      2,
    )}\n`,
  );
  return paths.sort();
}
