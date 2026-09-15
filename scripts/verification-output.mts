import { createHash } from "node:crypto";
import { z } from "zod";
import { publicationDestination } from "./publication-destination.mts";
import { boundedBytes } from "./publication-client.mts";
import { verifyPublicationOutput } from "./publication-live.mts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const VerificationInputSchema = z.strictObject({
  target: z.enum(["staging", "production"]),
  deploymentId: id,
  runId: id,
  checkRunId: id,
  dispatchRevision: sha,
  workflowRevision: sha,
  verificationDispatchRevision: sha.optional(),
  workerVersionId: z.uuid().optional(),
  build: z.strictObject({
    candidateChecksum: digest,
    commitSha: sha,
    treeSha: sha,
    manifestBlobSha: sha,
    artifactDigest: digest,
    fileCount: z.number().int().min(1).max(2000),
    totalBytes: z.number().int().min(1).max(100_000_000),
  }),
});

/** Read immutable public evidence and output bytes. Never rebuild, write Git, or deploy. */
export async function verifyRetainedPublication(
  value: unknown,
  probeSecret?: string,
  fetcher: typeof fetch = fetch,
) {
  try {
    const input = VerificationInputSchema.parse(value);
    const staging = input.target === "staging";
    const destination = publicationDestination(input.target);
    const repository = `PointCommunity/${destination.repository}`;
    const api = `https://api.github.com/repos/${repository}`;
    const { origin } = destination;
    const environment = staging ? "staging" : "github-pages";
    const read = async (url: string, maximum = 32_768) => {
      const bytes = await boundedBytes(
        await fetcher(url, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "PointSite-Builder",
            "cache-control": "no-cache",
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        }),
        maximum,
      );
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    };
    const native = async () => {
      z.object({
        object: z.object({ sha: z.literal(input.verificationDispatchRevision ?? input.build.commitSha) }),
      }).parse(await read(`${api}/git/ref/heads/main`));
      z.array(
        z.object({
          id: z
            .number()
            .int()
            .refine((value) => String(value) === input.deploymentId),
          sha: z.literal(input.dispatchRevision),
          environment: z.literal(environment),
        }),
      )
        .length(1)
        .parse(
          await read(
            `${api}/deployments?environment=${environment}&per_page=1`,
          ),
        );
      // Environment deployments may have null App attribution. The native Actions
      // check supplies the independently owned deployment link.
      z.object({
        id: z.number().int().refine((value) => String(value) === input.checkRunId),
        status: z.literal("completed"),
        head_sha: z.literal(input.dispatchRevision),
        details_url: z.literal(`https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`),
        app: z.object({ id: z.literal(15368), slug: z.literal("github-actions") }),
        deployment: z.object({ id: z.number().int().refine((value) => String(value) === input.deploymentId) }),
      }).parse(await read(`${api}/check-runs/${input.checkRunId}`));
      z.array(
        z.object({
          state: z.enum(["success", "failure", "error"]),
          environment: z.literal(environment),
          log_url: z.literal(
            `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`,
          ),
          environment_url: z.string().refine((value) => {
            try {
              const url = new URL(value);
              return (
                url.origin === origin &&
                url.pathname === "/" &&
                !url.search &&
                !url.hash &&
                !url.username &&
                !url.password
              );
            } catch {
              return false;
            }
          }),
        }),
      )
        .length(1)
        .parse(
          await read(
            `${api}/deployments/${input.deploymentId}/statuses?per_page=1`,
          ),
        );
    };
    await native();
    const blob = z
      .object({
        sha: z.literal(input.build.manifestBlobSha),
        encoding: z.literal("base64"),
        size: z.number().int().min(1).max(500_000),
        content: z.string().max(700_000),
      })
      .parse(
        await read(`${api}/git/blobs/${input.build.manifestBlobSha}`, 720_000),
      );
    const bytes = Buffer.from(blob.content, "base64");
    if (
      bytes.length !== blob.size ||
      createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== input.build.manifestBlobSha
    )
      throw Error("Manifest identity changed");
    const manifest = z
      .strictObject({
        artifactDigest: z.literal(input.build.artifactDigest),
        totalBytes: z.literal(input.build.totalBytes),
        files: z
          .array(
            z.strictObject({
              path: z.string(),
              bytes: z.number().int().min(0).max(100_000_000),
              sha256: digest,
            }),
          )
          .length(input.build.fileCount),
      })
      .parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    if (
      manifest.files.reduce((sum, file) => sum + file.bytes, 0) !==
        manifest.totalBytes ||
      manifest.files.some((file) => file.path === "__pointsite_release.json")
    )
      throw Error("Manifest totals changed");
    const release = z
      .strictObject({
        format: z.literal(2),
        candidateChecksum: z.literal(input.build.candidateChecksum),
        artifactDigest: z.literal(input.build.artifactDigest),
        workflowRevision: z.literal(input.workflowRevision),
        sourceCommit: z.literal(input.build.commitSha).optional(),
        ...(input.workerVersionId
          ? { workerVersionId: z.literal(input.workerVersionId!) }
          : {}),
      })
      .parse(await read(`${origin}/__pointsite_release.json`, 1024));
    const workerVersionId =
      "workerVersionId" in release
        ? (release.workerVersionId as string)
        : undefined;
    await verifyPublicationOutput(
      {
        target: input.target,
        ...manifest,
        candidateChecksum: input.build.candidateChecksum,
        workflowRevision: input.workflowRevision,
        ...(workerVersionId ? { workerVersionId } : {}),
        probeSecret,
      },
      fetcher,
    );
    await native();
    return {
      artifactDigest: input.build.artifactDigest,
      deploymentId: input.deploymentId,
      ...(workerVersionId ? { workerVersionId } : {}),
    };
  } catch {
    throw new Error("PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED");
  }
}
