import { z } from "zod";
import { validatePublicationInputs } from "./publication-inputs.mts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const builder = "https://builder.pointatx.org";

async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > maximum ||
    !response.body
  )
    throw new Error("PUBLICATION_REQUEST_REJECTED");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("PUBLICATION_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** A token lives only in this runner process and is renewed before its five-minute expiry. */
export class PublicationClient {
  private token: { value: string; refreshAt: number } | undefined;
  constructor(
    private readonly jobId: string,
    private readonly nonce: string,
    private readonly workflowRevision: string,
    private readonly environment: Record<
      string,
      string | undefined
    > = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    z.uuid().parse(jobId);
    nonceSchema.parse(nonce);
    sha.parse(workflowRevision);
  }

  private async identity(): Promise<string> {
    if (this.token && this.token.refreshAt > Date.now())
      return this.token.value;
    try {
      const url = new URL(this.environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
      const requestToken = this.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".actions.githubusercontent.com") ||
        url.username ||
        url.password ||
        url.port ||
        !requestToken
      )
        throw new Error("Invalid OIDC endpoint");
      url.searchParams.set(
        "audience",
        `${builder}/publish/${this.jobId}/${this.nonce}`,
      );
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${requestToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const bytes = await boundedBytes(response, 20_000);
      const { value } = z
        .object({ value: z.string().min(1).max(16_384) })
        .parse(JSON.parse(new TextDecoder().decode(bytes)));
      const claims = z
        .object({
          job_workflow_sha: z.literal(this.workflowRevision),
          exp: z.number().int().positive(),
        })
        .parse(
          JSON.parse(
            Buffer.from(value.split(".")[1] ?? "", "base64url").toString(
              "utf8",
            ),
          ),
        );
      const refreshAt = Math.min(
        Date.now() + 240_000,
        claims.exp * 1000 - 30_000,
      );
      if (refreshAt <= Date.now()) throw new Error("Expired OIDC token");
      // GitHub's authenticated token endpoint supplies this value. Builder verifies
      // the signature and every execution claim; decoding here only checks the checkout pin.
      this.token = { value, refreshAt };
      return value;
    } catch {
      throw new Error("PUBLICATION_IDENTITY_UNAVAILABLE");
    }
  }

  private async request(
    path: string,
    maximum: number,
    method = "GET",
    value?: unknown,
  ) {
    try {
      const body = value === undefined ? undefined : JSON.stringify(value);
      if (body && Buffer.byteLength(body) > 8192)
        throw new Error("PUBLICATION_REQUEST_REJECTED");
      const token = await this.identity();
      const response = await this.fetcher(
        `${builder}/api/publish/runner/${this.jobId}/${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      return await boundedBytes(response, maximum);
    } catch (error) {
      // Provider response bodies and credential-bearing errors must never enter Actions logs.
      throw new Error(
        error instanceof Error && /^PUBLICATION_[A-Z_]+$/.test(error.message)
          ? error.message
          : "PUBLICATION_REQUEST_REJECTED",
      );
    }
  }

  async claim(): Promise<void> {
    const bytes = await this.request("claim", 1000, "POST");
    try {
      z.strictObject({ claimed: z.literal(true) }).parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch {
      throw new Error("PUBLICATION_CLAIM_REJECTED");
    }
  }

  async inputs() {
    // The bounded document plus its separately repeated media paths can exceed
    // the editor's request-body limit. No image bytes are included here.
    const bytes = await this.request("inputs", 4_000_000);
    try {
      return await validatePublicationInputs(
        JSON.parse(new TextDecoder().decode(bytes)),
        this.workflowRevision,
      );
    } catch {
      throw new Error("PUBLICATION_INPUT_MISMATCH");
    }
  }

  async authorizeBuild(build: {
    candidateChecksum: string;
    commitSha: string;
    treeSha: string;
    manifestBlobSha: string;
    artifactDigest: string;
    fileCount: number;
    totalBytes: number;
  }) {
    const response = await this.request("build", 1000, "POST", build);
    z.strictObject({ authorized: z.literal(true) }).parse(
      JSON.parse(new TextDecoder().decode(response)),
    );
  }

  async commitBuild(expected: string) {
    sha.parse(expected);
    const response = await this.request("commit", 1000, "POST");
    z.strictObject({ commitSha: z.literal(expected) }).parse(
      JSON.parse(new TextDecoder().decode(response)),
    );
  }

  async authorizeDeployment() {
    const response = await this.request("authorize-deployment", 1000, "POST");
    z.strictObject({ authorized: z.literal(true) }).parse(
      JSON.parse(new TextDecoder().decode(response)),
    );
  }

  async reportDeployment(workerVersionId: string) {
    z.uuid().parse(workerVersionId);
    const response = await this.request("deployment", 1000, "POST", {
      workerVersionId,
    });
    z.strictObject({ recorded: z.literal(true) }).parse(
      JSON.parse(new TextDecoder().decode(response)),
    );
  }

  async chunk(assetId: string, index: number): Promise<Uint8Array> {
    z.uuid().parse(assetId);
    z.number().int().min(0).max(5).parse(index);
    return this.request(`assets/${assetId}/chunks/${index}`, 1_000_000);
  }
}
