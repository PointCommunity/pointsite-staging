import { z } from "zod";
import { PublicationClient } from "./publication-client.mts";
import {
  VerificationInputSchema,
  verifyRetainedPublication,
} from "./verification-output.mts";

try {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RUNNER_OS !== "Linux" ||
    process.env.RUNNER_ARCH !== "X64" ||
    process.version !== "v22.23.2"
  )
    throw new Error("PUBLICATION_RUNNER_INVALID");
  const job = z.uuid().parse(process.env.PUBLICATION_JOB_ID);
  const nonce = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env.PUBLICATION_NONCE);
  const source = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.PUBLICATION_SOURCE);
  const target = z
    .enum(["staging", "production"])
    .parse(process.env.PUBLICATION_TARGET);
  const client = new PublicationClient(
    job,
    nonce,
    source,
    process.env,
    fetch,
    "verification",
  );
  await client.claim();
  const input = VerificationInputSchema.parse(
    await client.verificationInputs(),
  );
  if (input.target !== target) throw new Error("PUBLICATION_INPUT_MISMATCH");
  await client.reportVerification(
    await verifyRetainedPublication(input, process.env.STAGING_PROBE_SECRET),
  );
  process.stdout.write("Retained publication output verified.\n");
} catch {
  process.stderr.write(
    "Verification did not complete. Builder retains this attempt for reconciliation.\n",
  );
  process.exitCode = 1;
}
