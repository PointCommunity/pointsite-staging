import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumDocument } from "../site-kit/canonicalize";
import {
  materializePublication,
  validatePublicationInputs,
} from "./publication-inputs.mts";
import { outputManifest } from "./output-manifest.mts";
import { preparePublicationCommit } from "./publication-git.mts";
import { verifyStaging } from "./verify-staging.mts";

export function buildPublicationSite(root: string, buildId: string) {
  // The Next subprocess receives no OIDC, GitHub, Cloudflare or probe credentials.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: "true",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    POINTSITE_BUILD_ID: buildId,
  };
  try {
    execFileSync(
      process.execPath,
      [join(root, "node_modules/next/dist/bin/next"), "build"],
      {
        cwd: root,
        env: environment,
        timeout: 15 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("PUBLICATION_BUILD_FAILED");
  }
}

/** Called only in a disposable, clean checkout of the OIDC-confirmed source revision. */
export async function preparePublicationBuild(
  root: string,
  jobId: string,
  workflowRevision: string,
  value: unknown,
  readChunk: (assetId: string, index: number) => Promise<Uint8Array>,
  build: (
    root: string,
    buildId: string,
  ) => void | Promise<void> = buildPublicationSite,
) {
  const input = await validatePublicationInputs(value, workflowRevision);
  const directory = await realpath(root);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (
    git(["rev-parse", "HEAD"]) !== workflowRevision ||
    git(["status", "--porcelain"])
  )
    throw new Error("PUBLICATION_CHECKOUT_CHANGED");
  const temporary = await mkdtemp(
    join(tmpdir(), "pointsite-publication-inputs-"),
  );
  try {
    const paths = await materializePublication(
      temporary,
      input,
      workflowRevision,
      readChunk,
    );
    // These directories belong to this fresh runner checkout. Remove stale exports and owned images.
    for (const path of [".next", "out", "public/assets/builder"]) {
      let parent = directory;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        const info = await lstat(parent).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (info && !info.isDirectory())
          throw new Error("PUBLICATION_PATH_INVALID");
      }
      await rm(join(directory, path), { recursive: true, force: true });
    }
    for (const path of paths) {
      let parent = directory;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (!(await lstat(parent)).isDirectory())
          throw new Error("PUBLICATION_PATH_INVALID");
      }
      const target = join(directory, path);
      const existing = await lstat(target).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      if (existing && (!existing.isFile() || existing.nlink !== 1))
        throw new Error("PUBLICATION_PATH_INVALID");
      await copyFile(join(temporary, path), target);
    }
    const buildId = await checksumDocument({
      candidateChecksum: input.candidateChecksum,
      workflowRevision,
    });
    await build(directory, buildId);
    if (input.candidate.mediaSelection === "referenced") {
      const retained = new Set(
        input.assets.map((asset) => `assets${asset.sourcePath.slice(7)}`),
      );
      const pruneImages = async (relative: string): Promise<void> => {
        if (!(await lstat(join(directory, "out"))).isDirectory())
          throw new Error("PUBLICATION_PATH_INVALID");
        const folder = join(directory, "out", relative);
        const info = await lstat(folder).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (!info) return;
        if (!info.isDirectory()) throw new Error("PUBLICATION_PATH_INVALID");
        const entries = await readdir(join(directory, "out", relative), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          const path = `${relative}/${entry.name}`;
          if (entry.isDirectory()) await pruneImages(path);
          else if (
            /\.(?:avif|jpe?g|png|webp)$/i.test(entry.name) &&
            !retained.has(path)
          )
            await rm(join(directory, "out", path));
        }
      };
      await pruneImages("assets");
    }
    const changed = git(["diff", "--name-only", "-z"])
      .split("\0")
      .filter(Boolean);
    if (
      changed.some(
        (path) =>
          !paths.includes(path) && !path.startsWith("public/assets/builder/"),
      )
    )
      throw new Error("PUBLICATION_RUNTIME_CHANGED");
    // Compare against captured input retained in memory, never a newly trusted manifest after build.
    for (const path of paths) {
      const target = join(directory, path);
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (await realpath(target)) !== target ||
        info.size > 5 * 1024 * 1024
      )
        throw new Error("PUBLICATION_INPUT_CHANGED");
      const actual = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      const expected = createHash("sha256")
        .update(await readFile(join(temporary, path)))
        .digest("hex");
      if (actual !== expected) throw new Error("PUBLICATION_INPUT_CHANGED");
    }
    const verification = await verifyStaging(directory, "");
    if (!verification.ok)
      throw new Error("PUBLICATION_STATIC_VERIFICATION_FAILED");
    const output = await outputManifest(join(directory, "out"));
    const outputPath = "content/builder-site.output.json";
    const previous = await lstat(join(directory, outputPath)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (previous && (!previous.isFile() || previous.nlink !== 1))
      throw new Error("PUBLICATION_PATH_INVALID");
    await writeFile(
      join(directory, outputPath),
      `${JSON.stringify(output)}\n`,
      { mode: 0o600 },
    );
    const commit = await preparePublicationCommit(directory, {
      jobId,
      baseSha: input.baseSha,
      requestedAt: input.requestedAt,
      files: [...paths, outputPath],
    });
    await writeFile(
      join(directory, "out/__pointsite_release.json"),
      JSON.stringify({
        format: 2,
        candidateChecksum: input.candidateChecksum,
        artifactDigest: output.artifactDigest,
        workflowRevision,
        sourceCommit: commit.commitSha,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return {
      build: {
        candidateChecksum: input.candidateChecksum,
        commitSha: commit.commitSha,
        treeSha: commit.treeSha,
        manifestBlobSha: commit.manifestBlobSha,
        artifactDigest: output.artifactDigest,
        fileCount: output.files.length,
        totalBytes: output.totalBytes,
      },
      output,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
