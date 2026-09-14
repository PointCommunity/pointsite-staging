import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const targetSchema = z.enum(["staging", "production"]);
const pathSchema = z
  .string()
  .regex(
    /^(?:content\/builder-site(?:\.(?:manifest|output))?\.json|public\/assets\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp))$/,
  );
const repositoryUrl = (target: "staging" | "production") =>
  `https://github.com/PointCommunity/${target === "staging" ? "pointsite-staging" : "pointsite"}.git`;

function git(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: string,
) {
  try {
    return execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      {
        cwd: root,
        env: {
          ...environment,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TRACE: "0",
          GIT_TRACE_CURL: "0",
          GIT_TRACE_PACKET: "0",
          GIT_CURL_VERBOSE: "0",
        },
        input,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1_000_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error("PUBLICATION_GIT_FAILED");
  }
}

export function fetchPublicationBase(
  root: string,
  target: "staging" | "production",
  baseSha: string,
): void {
  targetSchema.parse(target);
  sha.parse(baseSha);
  git(root, [
    "fetch",
    "--no-tags",
    "--depth=1",
    repositoryUrl(target),
    baseSha,
  ]);
}

/** Plumbing uses a separate index: the runtime checkout, its index and HEAD stay unchanged. */
export async function preparePublicationCommit(
  root: string,
  input: {
    jobId: string;
    baseSha: string;
    requestedAt: string;
    files: string[];
  },
) {
  z.uuid().parse(input.jobId);
  sha.parse(input.baseSha);
  z.iso.datetime().parse(input.requestedAt);
  const files = z.array(pathSchema).min(3).max(503).parse(input.files).sort();
  if (
    new Set(files).size !== files.length ||
    !files.includes("content/builder-site.json") ||
    !files.includes("content/builder-site.manifest.json") ||
    !files.includes("content/builder-site.output.json")
  )
    throw new Error("PUBLICATION_GIT_PATH_INVALID");
  const temporary = await mkdtemp(
    join(tmpdir(), "pointsite-publication-index-"),
  );
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporary, "index"),
    GIT_AUTHOR_NAME: "PointSite Builder",
    GIT_COMMITTER_NAME: "PointSite Builder",
    GIT_AUTHOR_EMAIL: "pointsite-builder@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "pointsite-builder@users.noreply.github.com",
    GIT_AUTHOR_DATE: input.requestedAt,
    GIT_COMMITTER_DATE: input.requestedAt,
  };
  try {
    git(root, ["read-tree", input.baseSha], environment);
    const directory = await realpath(root);
    let index = "";
    let manifestBlobSha = "";
    let total = 0;
    for (const path of files) {
      const absolute = join(directory, path);
      if ((await realpath(absolute)) !== absolute)
        throw new Error("PUBLICATION_GIT_PATH_INVALID");
      const info = await lstat(absolute);
      total += info.size;
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 5 * 1024 * 1024 ||
        total > 32 * 1024 * 1024
      )
        throw new Error("PUBLICATION_GIT_FILE_INVALID");
      const blob = sha.parse(
        git(
          root,
          ["hash-object", "-w", "--no-filters", "--", path],
          environment,
        ),
      );
      index += `100644 ${blob}\t${path}\0`;
      if (path === "content/builder-site.output.json") manifestBlobSha = blob;
    }
    git(root, ["update-index", "-z", "--index-info"], environment, index);
    const treeSha = sha.parse(git(root, ["write-tree"], environment));
    const commitSha = sha.parse(
      git(
        root,
        [
          "commit-tree",
          treeSha,
          "-p",
          input.baseSha,
          "-m",
          `PointSite publication ${input.jobId}`,
        ],
        environment,
      ),
    );
    return {
      commitSha,
      treeSha,
      manifestBlobSha,
      candidateRef: `refs/heads/builder-publications/${input.jobId}`,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Upload objects to a job-owned branch. Only Builder's fresh authority gate advances main. */
export function pushPublicationCommit(
  root: string,
  target: "staging" | "production",
  jobId: string,
  commitSha: string,
  token: string,
): void {
  targetSchema.parse(target);
  z.uuid().parse(jobId);
  sha.parse(commitSha);
  z.string().min(20).max(4096).parse(token);
  const url = repositoryUrl(target);
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `http.${url}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.followRedirects",
    GIT_CONFIG_VALUE_2: "false",
  };
  git(
    root,
    [
      "push",
      "--porcelain",
      "--no-verify",
      url,
      `${commitSha}:refs/heads/builder-publications/${jobId}`,
    ],
    environment,
  );
}
