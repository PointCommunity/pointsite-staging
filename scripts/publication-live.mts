import { createHash } from "node:crypto";
import { z } from "zod";
import { checksumDocument } from "../site-kit/canonicalize";
import type { OutputFile } from "./output-manifest.mts";

/** CDN convergence may require another read. Never repeat a commit or deployment here. */
export async function verifyPublicationOutputWithRetry(
  input: Parameters<typeof verifyPublicationOutput>[0],
  fetcher: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await verifyPublicationOutput(input, fetcher);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED" ||
        attempt === 2
      )
        throw error;
      await sleep([2_000, 5_000][attempt]);
    }
  }
}

/** Verify every exported byte against the retained manifest; never forward a credential across redirects. */
export async function verifyPublicationOutput(
  input: {
    target: "staging" | "production";
    files: OutputFile[];
    artifactDigest: string;
    candidateChecksum: string;
    workflowRevision: string;
    workerVersionId?: string;
    probeSecret?: string;
  },
  fetcher: typeof fetch = fetch,
) {
  z.enum(["staging", "production"]).parse(input.target);
  const origin =
    input.target === "staging"
      ? "https://staging.pointatx.org"
      : "https://pointatx.org";
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  digest.parse(input.artifactDigest);
  digest.parse(input.candidateChecksum);
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.workflowRevision);
  if (input.target === "staging") {
    z.uuid().parse(input.workerVersionId);
    z.string().min(32).max(4096).parse(input.probeSecret);
  }
  const files = z
    .array(
      z.strictObject({
        path: z
          .string()
          .min(1)
          .max(1024)
          .refine(
            (path) =>
              !path.includes("\\") &&
              path
                .split("/")
                .every((part) => part !== "" && part !== "." && part !== ".."),
          ),
        sha256: digest,
        bytes: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(2000)
    .parse(input.files);
  if (
    (await checksumDocument(files)) !== input.artifactDigest ||
    files.reduce((total, file) => total + file.bytes, 0) > 100_000_000 ||
    !files.some((file) => file.path === "index.html") ||
    files.some((file, index) => index > 0 && files[index - 1].path >= file.path)
  )
    throw new Error("PUBLICATION_OUTPUT_MISMATCH");
  try {
    const read = (path: string, protectedAsset = false) =>
      fetcher(`${origin}${path}`, {
        headers: {
          "cache-control": "no-cache",
          ...(protectedAsset && input.target === "staging"
            ? { "X-PointSite-Staging-Probe": input.probeSecret! }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    const identity = async () => {
      const response = await read("/__pointsite_release.json");
      if (!response.ok || !response.body) throw new Error("Missing identity");
      const reader = response.body.getReader();
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 1024) throw new Error("Invalid identity");
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      z.strictObject({
        format: z.literal(2),
        candidateChecksum: z.literal(input.candidateChecksum),
        artifactDigest: z.literal(input.artifactDigest),
        workflowRevision: z.literal(input.workflowRevision),
        ...(input.target === "staging"
          ? { workerVersionId: z.literal(input.workerVersionId!) }
          : {}),
      }).parse(JSON.parse(text + decoder.decode()));
    };
    if (input.target === "staging") {
      const anonymous = await read("/");
      await anonymous.body?.cancel();
      if (![401, 403].includes(anonymous.status))
        throw new Error("Anonymous output exposed");
    }
    await identity();
    for (const file of files) {
      const path =
        file.path === "index.html"
          ? ""
          : file.path.endsWith("/index.html")
            ? file.path.slice(0, -10)
            : input.target === "staging" && file.path.endsWith(".html")
              ? file.path.slice(0, -5)
              : file.path;
      const response = await read(
        `/${path.split("/").map(encodeURIComponent).join("/")}`,
        true,
      );
      if (
        (!response.ok &&
          !(file.path === "404.html" && response.status === 404)) ||
        !response.body
      )
        throw new Error("Missing output");
      if (
        input.target === "staging" &&
        (response.headers.get("x-content-type-options") !== "nosniff" ||
          response.headers.get("x-frame-options") !== "DENY")
      )
        throw new Error("Unsafe output headers");
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > file.bytes) throw new Error("Changed output");
          hash.update(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
        throw new Error("Changed output");
    }
    await identity();
    return {
      filesVerified: files.length,
      artifactDigest: input.artifactDigest,
    };
  } catch {
    throw new Error("PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED");
  }
}
