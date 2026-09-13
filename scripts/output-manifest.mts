import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checksumDocument } from "../site-kit/canonicalize";

export interface OutputFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** Metadata and timestamps never affect identity. The separate attestation cannot hash itself. */
export async function outputManifest(root: string) {
  const files: OutputFile[] = [];
  let totalBytes = 0;
  const visit = async (relative: string) => {
    const entries = (await readdir(join(root, relative))).sort();
    for (const name of entries) {
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      )
        throw new Error("PUBLICATION_OUTPUT_LINK_INVALID");
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (path === "__pointsite_release.json") continue;
      totalBytes += info.size;
      if (files.length >= 2000 || totalBytes > 100_000_000)
        throw new Error("PUBLICATION_OUTPUT_TOO_LARGE");
      files.push({
        path,
        bytes: info.size,
        sha256: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      });
    }
  };
  await visit("");
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (!files.some((file) => file.path === "index.html"))
    throw new Error("PUBLICATION_OUTPUT_INCOMPLETE");
  return { files, totalBytes, artifactDigest: await checksumDocument(files) };
}
