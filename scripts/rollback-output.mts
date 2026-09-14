import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { boundedBytes } from "./publication-client.mts";
import { outputManifest } from "./output-manifest.mts";

const sha = z.string().regex(/^[a-f0-9]{40}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const size = {
  artifactDigest: digest,
  fileCount: z.number().int().min(1).max(2000),
  totalBytes: z.number().int().min(1).max(100_000_000),
};
export const RollbackInputSchema = z.strictObject({
  candidateChecksum: digest,
  baseSha: sha,
  workflowRevision: sha,
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("baseline"),
      sourceRevision: sha,
      ...size,
      archiveRevision: sha,
      archivePath: z.literal("publication-baseline/site.tar.gz"),
      archiveBlobSha: sha,
      archiveSha256: digest,
      archiveBytes: z.number().int().min(1).max(4_000_000),
      manifestPath: z.literal("publication-baseline/manifest.json"),
      manifestBlobSha: sha,
    }),
    z.strictObject({
      kind: z.literal("publication"),
      ...size,
      commitSha: sha,
      treeSha: sha,
      manifestBlobSha: sha,
      workflowRevision: sha,
      candidateChecksum: digest,
    }),
  ]),
});

/** Every subprocess receives a fresh HOME and no GitHub, OIDC or Cloudflare credentials. */
function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    CI: "true",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: join(home, "npm-cache"),
  };
}

export async function restoreRollbackOutput(
  root: string,
  value: unknown,
  fetcher: typeof fetch = fetch,
) {
  const input = RollbackInputSchema.parse(value),
    source = input.source;
  const temporary = await mkdtemp(join(tmpdir(), "pointsite-rollback-"));
  const run = (command: string, args: string[], cwd = temporary) =>
    execFileSync(command, args, {
      cwd,
      env: environment(temporary),
      timeout: 20 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const output = join(temporary, "output");
    if (source.kind === "baseline") {
      const read = async (path: string, blobSha: string, maximum: number) => {
        const bytes = await boundedBytes(
          await fetcher(
            `https://raw.githubusercontent.com/PointCommunity/pointsite/${source.archiveRevision}/${path}`,
            {
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: { "cache-control": "no-cache" },
            },
          ),
          maximum,
        );
        assert.equal(
          createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex"),
          blobSha,
        );
        return bytes;
      };
      const archive = await read(
        source.archivePath,
        source.archiveBlobSha,
        source.archiveBytes,
      );
      assert.equal(archive.length, source.archiveBytes);
      assert.equal(
        createHash("sha256").update(archive).digest("hex"),
        source.archiveSha256,
      );
      const manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await read(source.manifestPath, source.manifestBlobSha, 500_000),
        ),
      );
      assert.equal(manifest.sourceRevision, source.sourceRevision);
      await writeFile(join(temporary, "site.tar.gz"), archive, {
        flag: "wx",
        mode: 0o600,
      });
      await mkdir(output);
      // Python's stdlib reads the fixed archive format; links, special files and traversal never reach disk.
      run("python3", [
        "-c",
        String.raw`
import pathlib,sys,tarfile
destination=pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1],'r:gz') as archive:
    members=archive.getmembers()
    assert 1 <= len(members) <= 2000
    assert sum(member.size for member in members) <= 100_000_000
    seen=set()
    for member in members:
        path=pathlib.PurePosixPath(member.name)
        assert member.isfile() and not path.is_absolute() and '..' not in path.parts and '\\' not in member.name
        assert str(path)==member.name and member.name not in seen and member.size >= 0
        seen.add(member.name)
        target=destination.joinpath(*path.parts)
        target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('xb') as file, archive.extractfile(member) as content:
            file.write(content.read(member.size))
`,
        join(temporary, "site.tar.gz"),
        output,
      ]);
      const actual = await outputManifest(output);
      assert.deepEqual(actual.files, manifest.files);
      assert.equal(actual.artifactDigest, manifest.artifactDigest);
    } else {
      const checkout = join(temporary, "renderer");
      await mkdir(checkout);
      const git = (...args: string[]) =>
        run(
          "git",
          [
            "-c",
            "http.followRedirects=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          checkout,
        );
      git("init", "--object-format=sha1");
      git(
        "fetch",
        "--depth=1",
        "--no-tags",
        "https://github.com/PointCommunity/pointsite-staging.git",
        source.workflowRevision,
      );
      git("checkout", "--detach", source.workflowRevision);
      git(
        "fetch",
        "--depth=1",
        "--no-tags",
        "https://github.com/PointCommunity/pointsite.git",
        source.commitSha,
      );
      assert.equal(
        git("rev-parse", `${source.commitSha}^{tree}`).toString().trim(),
        source.treeSha,
      );
      assert.equal(
        git("rev-parse", `${source.commitSha}:content/builder-site.output.json`)
          .toString()
          .trim(),
        source.manifestBlobSha,
      );
      const manifest = JSON.parse(
        git(
          "show",
          `${source.commitSha}:content/builder-site.output.json`,
        ).toString(),
      );
      const captured = JSON.parse(
        git(
          "show",
          `${source.commitSha}:content/builder-site.manifest.json`,
        ).toString(),
      );
      const {
        candidateChecksum,
        assets,
        source: repository,
        ...candidate
      } = captured;
      assert.equal(repository, "PointCommunity/pointsite-builder");
      assert.equal(candidateChecksum, source.candidateChecksum);
      const value = {
        candidate,
        candidateChecksum,
        assets,
        document: JSON.parse(
          git(
            "show",
            `${source.commitSha}:content/builder-site.json`,
          ).toString(),
        ),
        baseSha: source.commitSha,
        requestedAt: git("show", "-s", "--format=%aI", source.commitSha)
          .toString()
          .trim(),
      };
      await writeFile(join(temporary, "inputs.json"), JSON.stringify(value), {
        flag: "wx",
        mode: 0o600,
      });
      run(
        "npm",
        ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        checkout,
      );
      // Execute only the recorded renderer commit. The public input commit never supplies executable code.
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          String.raw`
        import {readFile} from 'node:fs/promises';
        import {execFileSync} from 'node:child_process';
        import {preparePublicationBuild} from './scripts/publication-build.mts';
        import {validatePublicationInputs} from './scripts/publication-inputs.mts';
        const [file,revision]=process.argv.slice(1);
        const input=await validatePublicationInputs(JSON.parse(await readFile(file,'utf8')),revision);
        await preparePublicationBuild(process.cwd(),crypto.randomUUID(),revision,input,async(id,index)=>{
          const asset=input.assets.find(asset=>asset.assetId===id);
          if(!asset) throw Error('Missing asset');
          const bytes=execFileSync('git',['show',input.baseSha+':public'+asset.sourcePath],{maxBuffer:6*1024*1024});
          return bytes.subarray(index*1_000_000,Math.min((index+1)*1_000_000,bytes.length));
        });
      `,
          join(temporary, "inputs.json"),
          source.workflowRevision,
        ],
        checkout,
      );
      const actual = await outputManifest(join(checkout, "out"));
      assert.deepEqual(actual, manifest);
      await cp(join(checkout, "out"), output, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    const actual = await outputManifest(output);
    assert.equal(actual.artifactDigest, source.artifactDigest);
    assert.equal(actual.files.length, source.fileCount);
    assert.equal(actual.totalBytes, source.totalBytes);
    await rm(join(output, "__pointsite_release.json"), { force: true });
    await writeFile(
      join(output, "__pointsite_release.json"),
      JSON.stringify({
        format: 2,
        candidateChecksum: input.candidateChecksum,
        artifactDigest: source.artifactDigest,
        workflowRevision: input.workflowRevision,
        sourceCommit:
          source.kind === "baseline" ? source.sourceRevision : source.commitSha,
      }),
      { flag: "wx", mode: 0o600 },
    );
    // The caller supplies a disposable runner checkout; refuse an existing export rather than overwrite it.
    await cp(output, join(root, "out"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return actual;
  } catch {
    throw new Error("ROLLBACK_OUTPUT_UNCONFIRMED");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
