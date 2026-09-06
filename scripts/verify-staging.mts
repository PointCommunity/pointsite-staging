import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { checksumDocument } from "../site-kit/canonicalize";
import { SiteDocumentSchema } from "../site-kit/schema";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
interface Manifest {
  rendererVersion: string;
  source: string;
  sha256?: string;
  revisionId?: string;
  revisionChecksum?: string;
  candidateChecksum?: string;
}

export function stagingProbeHeaders(
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const secret = environment.STAGING_PROBE_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Live verification requires a staging probe secret");
  return { "X-PointSite-Staging-Probe": secret };
}

export function liveRouteUrl(origin: string, route: string): string {
  const base = origin.replace(/\/$/, "");
  return route === "/" ? `${base}/` : `${base}${route}/`;
}

export async function liveResponseDetail(response: Response): Promise<string> {
  const safeHeaders =
    response.headers.get("x-content-type-options") === "nosniff" &&
    response.headers.get("x-frame-options") === "DENY";
  const diagnostics = [
    `security headers ${safeHeaders ? "present" : "missing"}`,
    response.headers.get("cf-mitigated")
      ? `cf-mitigated=${response.headers.get("cf-mitigated")}`
      : null,
    response.headers.get("server")
      ? `server=${response.headers.get("server")}`
      : null,
    response.headers.get("content-type")
      ? `content-type=${response.headers.get("content-type")}`
      : null,
  ].filter(Boolean);
  if (!response.ok) {
    const body = (await response.clone().text())
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (body) diagnostics.push(`body=${JSON.stringify(body)}`);
  }
  return `${response.status}; ${diagnostics.join("; ")}`;
}

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesBelow(join(path, entry.name))
        : Promise.resolve([join(path, entry.name)]),
    ),
  );
  return nested.flat();
}

export async function expectedCandidateChecksum(
  content: string,
  manifest: Manifest,
  media: Array<{ path: string; encoded: string }> = [],
): Promise<string> {
  if (
    manifest.candidateChecksum &&
    manifest.revisionId &&
    manifest.revisionChecksum
  )
    return checksumDocument({
      revisionId: manifest.revisionId,
      revisionChecksum: manifest.revisionChecksum,
      rendererVersion: manifest.rendererVersion,
      content,
      media,
    });
  return createHash("sha256").update(content).digest("hex");
}

export async function verifyStaging(root = process.cwd()) {
  const checks: Check[] = [];
  const content = await readFile(
    join(root, "content/builder-site.json"),
    "utf8",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "content/builder-site.manifest.json"), "utf8"),
  ) as Manifest;
  const parsed = SiteDocumentSchema.safeParse(JSON.parse(content) as unknown);
  checks.push({
    name: "document-schema",
    passed: parsed.success,
    detail: parsed.success
      ? `SiteDocument v${parsed.data.schemaVersion} is valid`
      : parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
  });
  if (!parsed.success)
    return { ok: false, checkedAt: new Date().toISOString(), checks };
  const document = parsed.data;
  checks.push({
    name: "renderer-version",
    passed: manifest.rendererVersion === document.rendererVersion,
    detail: `${manifest.rendererVersion} / ${document.rendererVersion}`,
  });
  checks.push({
    name: "source-repository",
    passed: manifest.source === "PointCommunity/pointsite-builder",
    detail: manifest.source,
  });
  const candidateMedia = await Promise.all(
    document.media
      .filter((item) => item.sourcePath.startsWith("/assets/builder/"))
      .map(async (item) => ({
        path: `public${item.sourcePath}`,
        encoded: Buffer.from(
          await readFile(join(root, "public", item.sourcePath)),
        ).toString("base64"),
      })),
  );
  const observedChecksum = await expectedCandidateChecksum(
    content,
    manifest,
    candidateMedia,
  );
  const declaredChecksum = manifest.candidateChecksum ?? manifest.sha256 ?? "";
  checks.push({
    name: "candidate-checksum",
    passed: observedChecksum === declaredChecksum,
    detail: observedChecksum,
  });
  for (const page of document.pages.filter(
    (item) => item.status !== "hidden",
  )) {
    const output =
      page.route === "/"
        ? join(root, "out/index.html")
        : join(root, `out${page.route}/index.html`);
    const present = await stat(output)
      .then((value) => value.isFile())
      .catch(() => false);
    checks.push({
      name: `route:${page.route}`,
      passed: present,
      detail: output.slice(root.length + 1),
    });
    if (present) {
      const html = await readFile(output, "utf8");
      const images = html.match(/<img\b[^>]*>/gi) ?? [];
      const accessible =
        /<html[^>]+lang="en"/i.test(html) &&
        /href="#point-main"/i.test(html) &&
        /<main[^>]+id="point-main"/i.test(html) &&
        /<h1\b/i.test(html) &&
        images.every((image) => /\balt="[^"]*"/i.test(image));
      checks.push({
        name: `accessibility:${page.route}`,
        passed: accessible,
        detail: accessible
          ? "language, skip target, main, heading, and image alternatives present"
          : "required static accessibility contract failed",
      });
    }
  }
  for (const media of document.media) {
    const asset = join(root, "public", media.sourcePath);
    const present = await stat(asset)
      .then((value) => value.isFile())
      .catch(() => false);
    checks.push({
      name: `asset:${media.sourcePath}`,
      passed: present,
      detail: present ? "present" : "missing",
    });
  }
  const outFiles = await filesBelow(join(root, "out"));
  const banned =
    /CF-Access-Jwt-Assertion|GITHUB_APP_PRIVATE_KEY|D1Database|R2Bucket|\/api\/drafts/i;
  let leaked = "";
  for (const file of outFiles.filter((item) =>
    /\.(?:html|js|json|txt|xml)$/.test(item),
  )) {
    if (banned.test(await readFile(file, "utf8"))) {
      leaked = file;
      break;
    }
  }
  checks.push({
    name: "static-only-output",
    passed: !leaked,
    detail: leaked
      ? leaked.slice(root.length + 1)
      : `${outFiles.length} files scanned`,
  });
  const liveUrl = process.env.STAGING_URL?.replace(/\/$/, "");
  if (liveUrl) {
    const serviceHeaders = stagingProbeHeaders();
    const anonymous = await fetch(liveUrl, { redirect: "manual" });
    const anonymousDenied = [301, 302, 303, 307, 308, 401, 403].includes(
      anonymous.status,
    );
    checks.push({
      name: "live:anonymous-access-denied",
      passed: anonymousDenied,
      detail: `anonymous status ${anonymous.status}`,
    });
    for (const page of document.pages.filter(
      (item) => item.status !== "hidden",
    )) {
      const response = await fetch(liveRouteUrl(liveUrl, page.route), {
        headers: serviceHeaders,
        redirect: "manual",
      });
      const safeHeaders =
        response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("x-frame-options") === "DENY";
      checks.push({
        name: `live:${page.route}`,
        passed: response.ok && safeHeaders,
        detail: await liveResponseDetail(response),
      });
    }
  }
  return {
    ok: checks.every((check) => check.passed),
    checkedAt: new Date().toISOString(),
    candidateChecksum: declaredChecksum,
    revisionId: manifest.revisionId ?? null,
    revisionChecksum: manifest.revisionChecksum ?? null,
    rendererVersion: manifest.rendererVersion,
    routes: document.pages.length,
    assets: document.media.length,
    liveProbes: liveUrl ? "completed" : "not-requested",
    checks,
  };
}

async function main() {
  const evidence = await verifyStaging(resolve("."));
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/staging-evidence.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
