import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

interface CommandResult {
  exitCode: number;
  output: string;
}

interface WorkerVersion {
  id: string;
  tag?: string;
  metadata?: { tag?: string };
  annotations?: Record<string, string>;
}

interface WorkerDeployment {
  id: string;
  versions: Array<{ version_id: string; percentage: number }>;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (args) => {
  const result = spawnSync("npx", args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  return { exitCode: result.status ?? 1, output };
};

export function isTransientDeployFailure(output: string): boolean {
  return /(?:\b(?:http|status|code)\s*[:=]?\s*(?:429|5\d\d)\b|->\s*(?:429|5\d\d)\b|\b(?:429|5\d\d)\s+(?:too many requests|service unavailable|bad gateway|gateway timeout|internal server error)\b|service unavailable|upstream connect error|connection (?:termination|reset)|econnreset|etimedout|socket hang up|network error)/i.test(
    output,
  );
}

function versionTag(version: WorkerVersion): string | undefined {
  return (
    version.tag ??
    version.metadata?.tag ??
    version.annotations?.["workers/tag"] ??
    version.annotations?.["workers/version_tag"]
  );
}

export function reconcileExpectedDeployment(
  versions: WorkerVersion[],
  deployments: WorkerDeployment[],
  expectedTag: string,
): { deploymentId: string; versionId: string } | null {
  const expectedVersionIds = new Set(
    versions
      .filter((version) => versionTag(version) === expectedTag)
      .map((version) => version.id),
  );
  const active = deployments.at(-1);
  if (!active || active.versions.length !== 1) return null;
  const selected = active.versions[0];
  if (
    selected.percentage !== 100 ||
    !expectedVersionIds.has(selected.version_id)
  )
    return null;
  return { deploymentId: active.id, versionId: selected.version_id };
}

async function commandJson<T>(run: CommandRunner, args: string[]): Promise<T> {
  const result = await run(args);
  if (result.exitCode !== 0)
    throw new Error(`Cloudflare reconciliation query failed: ${result.output}`);
  const start = result.output.indexOf("[");
  const end = result.output.lastIndexOf("]");
  if (start < 0 || end < start)
    throw new Error("Cloudflare reconciliation returned invalid JSON");
  return JSON.parse(result.output.slice(start, end + 1)) as T;
}

export async function deployWithReconciliation({
  commitSha,
  candidateChecksum,
  run = defaultRunner,
  wait = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  retryDelaysMs = [0, 2_000, 5_000, 10_000],
}: {
  commitSha: string;
  candidateChecksum: string;
  run?: CommandRunner;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: number[];
}): Promise<
  | { status: "deployed" }
  | { status: "reconciled"; deploymentId: string; versionId: string }
> {
  const deployed = await run([
    "wrangler",
    "deploy",
    "--tag",
    commitSha,
    "--message",
    `Staging candidate ${candidateChecksum} from ${commitSha}`,
  ]);
  if (deployed.exitCode === 0) return { status: "deployed" };
  if (!isTransientDeployFailure(deployed.output))
    throw new Error(`Staging deployment failed: ${deployed.output}`);

  let lastQueryError: unknown;
  for (const delay of retryDelaysMs) {
    await wait(delay);
    try {
      const [versions, deployments] = await Promise.all([
        commandJson<WorkerVersion[]>(run, [
          "wrangler",
          "versions",
          "list",
          "--json",
        ]),
        commandJson<WorkerDeployment[]>(run, [
          "wrangler",
          "deployments",
          "list",
          "--json",
        ]),
      ]);
      const reconciled = reconcileExpectedDeployment(
        versions,
        deployments,
        commitSha,
      );
      if (reconciled) return { status: "reconciled", ...reconciled };
    } catch (error) {
      lastQueryError = error;
    }
  }
  const detail =
    lastQueryError instanceof Error ? ` ${lastQueryError.message}` : "";
  throw new Error(
    `Cloudflare returned an uncertain deployment result, and the expected tagged version was not confirmed at 100% traffic.${detail}`,
  );
}

async function main() {
  const commitSha = process.env.GITHUB_SHA;
  if (!commitSha) throw new Error("GITHUB_SHA is required for deployment");
  const manifest = JSON.parse(
    await readFile("content/builder-site.manifest.json", "utf8"),
  ) as { candidateChecksum?: string };
  if (!manifest.candidateChecksum)
    throw new Error("The exact candidate checksum is required for deployment");
  const result = await deployWithReconciliation({
    commitSha,
    candidateChecksum: manifest.candidateChecksum,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** A successful CLI exit is not the native deployment identity. Always read back active traffic. */
export async function deployPublicationWithProof(input: {
  commitSha: string;
  candidateChecksum: string;
  run: CommandRunner;
}) {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.commitSha);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.candidateChecksum);
  try {
    const deployed = await deployWithReconciliation(input);
    if (deployed.status === "reconciled")
      return z.uuid().parse(deployed.versionId);
    const versions = await commandJson<WorkerVersion[]>(input.run, [
      "wrangler",
      "versions",
      "list",
      "--json",
    ]);
    const deployments = await commandJson<WorkerDeployment[]>(input.run, [
      "wrangler",
      "deployments",
      "list",
      "--json",
    ]);
    const active = reconcileExpectedDeployment(
      versions,
      deployments,
      input.commitSha,
    );
    if (!active) throw new Error("Native deployment not confirmed");
    return z.uuid().parse(active.versionId);
  } catch {
    throw new Error("PUBLICATION_DEPLOYMENT_UNCONFIRMED");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
