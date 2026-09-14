import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrateDocument } from "../site-kit/migrations";
import { publicationMediaPaths } from "../site-kit/publication-media";

/** Remove only unused exported images; source assets and the saved document stay intact. */
export async function prunePublicationMedia(root: string): Promise<number> {
  const manifest = JSON.parse(
    await readFile(join(root, "content/builder-site.manifest.json"), "utf8"),
  ) as { mediaSelection?: string };
  if (!manifest.mediaSelection) return 0;
  if (manifest.mediaSelection !== "referenced")
    throw new Error("Unsupported publication media selection");
  const { document } = migrateDocument(
    JSON.parse(await readFile(join(root, "content/builder-site.json"), "utf8")),
  );
  const used = new Set(
    publicationMediaPaths(document).map((path) => join(root, "out", path)),
  );
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("Exported assets cannot contain symbolic links");
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile()) files.push(path);
  };
  await visit(join(root, "out/assets"));
  for (const path of used)
    if (!files.includes(path))
      throw new Error("A referenced image is missing from the export");
  const unused = files.filter(
    (path) => /\.(?:avif|jpe?g|png|webp)$/i.test(path) && !used.has(path),
  );
  for (const path of unused) await unlink(path);
  return unused.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    `Excluded ${await prunePublicationMedia(resolve("."))} unused images from the static export.`,
  );
