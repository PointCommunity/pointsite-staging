import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { checksumDocument } from "../site-kit/canonicalize";
import { verifyRetainedPublication } from "../scripts/verification-output.mts";

async function fixture(target: "staging" | "production", change = "") {
  const body = Buffer.from("<h1>Retained public output</h1>");
  const files = [
    {
      path: "index.html",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  ];
  const artifactDigest = await checksumDocument(files);
  const manifest = Buffer.from(
    JSON.stringify({ files, artifactDigest, totalBytes: body.length }),
  );
  const workerVersionId = randomUUID();
  const input = {
    target,
    deploymentId: "123",
    runId: "234",
    checkRunId: "345",
    dispatchRevision: "a".repeat(40),
    workflowRevision: "b".repeat(40),
    ...(target === "staging" ? { workerVersionId } : {}),
    build: {
      candidateChecksum: "c".repeat(64),
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      manifestBlobSha: createHash("sha1")
        .update(`blob ${manifest.length}\0`)
        .update(manifest)
        .digest("hex"),
      artifactDigest,
      fileCount: files.length,
      totalBytes: body.length,
    },
  };
  const repository = `PointCommunity/${target === "staging" ? "pointsite-staging" : "pointsite"}`;
  const origin =
    target === "staging"
      ? "https://staging.pointatx.org"
      : "https://pointatx.org";
  const environment = target === "staging" ? "staging" : "github-pages";
  const probeSecret = "fixture-probe-secret-never-forwarded";
  let deployments = 0;
  let fileReads = 0;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value);
    calls.push(url.href);
    assert.ok(!init?.method || init.method === "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(
      headers.get("X-PointSite-Staging-Probe"),
      target === "staging" &&
        url.origin === origin &&
        url.pathname === "/" &&
        fileReads++ > 0
        ? probeSecret
        : null,
    );
    if (url.hostname === "api.github.com") {
      assert.ok(url.pathname.startsWith(`/repos/${repository}/`));
      if (url.pathname.includes("/git/blobs/"))
        return Response.json({
          sha: input.build.manifestBlobSha,
          encoding: "base64",
          size: manifest.length,
          content:
            change === "blob"
              ? Buffer.from("substituted manifest").toString("base64")
              : manifest.toString("base64"),
        });
      if (url.pathname.endsWith("/git/ref/heads/main"))
        return Response.json({
          object: {
            sha: change === "main" ? "f".repeat(40) : input.build.commitSha,
          },
        });
      if (url.pathname.endsWith("/deployments"))
        return Response.json([
          {
            id: change === "replacement" && deployments++ > 0 ? 124 : 123,
            sha: input.dispatchRevision,
            environment,
            performed_via_github_app: { id: 15368, slug: "github-actions" },
          },
        ]);
      if (url.pathname.endsWith("/deployments/123/statuses"))
        return Response.json([
          {
            state: change === "pending" ? "in_progress" : "failure",
            environment,
            log_url: `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`,
            environment_url: origin,
          },
        ]);
      throw Error("Unexpected GitHub URL");
    }
    assert.equal(url.origin, origin);
    if (url.pathname === "/__pointsite_release.json")
      return Response.json({
        format: 2,
        candidateChecksum: input.build.candidateChecksum,
        artifactDigest,
        workflowRevision: input.workflowRevision,
        ...(target === "staging"
          ? {
              workerVersionId:
                change === "worker" ? randomUUID() : workerVersionId,
            }
          : {}),
      });
    if (target === "staging" && !headers.has("X-PointSite-Staging-Probe"))
      return new Response("Protected", { status: 401 });
    return new Response(change === "file" ? "changed public bytes" : body, {
      headers: {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  };
  return { input, fetcher, calls, workerVersionId, probeSecret };
}

test("verifies retained output after native deployment failure without writing or rebuilding", async () => {
  for (const target of ["staging", "production"] as const) {
    const f = await fixture(target);
    assert.deepEqual(
      await verifyRetainedPublication(f.input, f.probeSecret, f.fetcher),
      {
        artifactDigest: f.input.build.artifactDigest,
        deploymentId: f.input.deploymentId,
        ...(target === "staging" ? { workerVersionId: f.workerVersionId } : {}),
      },
    );
    assert.ok(
      f.calls.some((url) =>
        url.includes(`/git/blobs/${f.input.build.manifestBlobSha}`),
      ),
    );
  }
});

test("rejects a changed manifest, output, main, deployment, or incomplete native status", async () => {
  for (const failure of ["blob", "file", "main", "replacement", "pending"]) {
    const f = await fixture("production", failure);
    await assert.rejects(
      verifyRetainedPublication(f.input, undefined, f.fetcher),
      /PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED/,
      failure,
    );
  }
});

test("requires an independently captured native Worker identity for Staging", async () => {
  const f = await fixture("staging", "worker");
  await assert.rejects(
    verifyRetainedPublication(f.input, f.probeSecret, f.fetcher),
    /PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED/,
  );
  f.calls.length = 0;
  await assert.rejects(
    verifyRetainedPublication(
      { ...f.input, workerVersionId: undefined },
      f.probeSecret,
      f.fetcher,
    ),
    /PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED/,
  );
  assert.equal(f.calls.length, 0);
});
