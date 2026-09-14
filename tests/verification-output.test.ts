import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { checksumDocument } from "../site-kit/canonicalize";
import { verifyRetainedPublication } from "../scripts/verification-output.mts";

async function fixture(
  target: "staging" | "production",
  change = "",
  pages = false,
) {
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
    ...(pages ? { verificationDispatchRevision: "f".repeat(40) } : {}),
    ...(target === "staging" && !pages ? { workerVersionId } : {}),
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
        !pages &&
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
            sha: change === "main" ? "0".repeat(40) : (input.verificationDispatchRevision ?? input.build.commitSha),
          },
        });
      if (url.pathname.endsWith("/deployments"))
        return Response.json([
          {
            id: change === "replacement" && deployments++ > 0 ? 124 : 123,
            sha: input.dispatchRevision,
            environment,
            performed_via_github_app: null,
          },
        ]);
      if (url.pathname.endsWith("/check-runs/345"))
        return Response.json({
          id: 345,
          status: change === "check-pending" ? "in_progress" : "completed",
          head_sha: change === "check-source" ? "0".repeat(40) : input.dispatchRevision,
          details_url: `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`,
          app: { id: change === "check-app" ? 1 : 15368, slug: "github-actions" },
          deployment: change === "check-missing" ? null : { id: change === "check-link" ? 124 : 123 },
        });
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
        ...(pages ? { sourceCommit: change === "release-source" ? "0".repeat(40) : input.build.commitSha } : {}),
        ...(target === "staging" && !pages
          ? {
              workerVersionId:
                change === "worker" ? randomUUID() : workerVersionId,
            }
          : {}),
      });
    if (
      target === "staging" &&
      !pages &&
      !headers.has("X-PointSite-Staging-Probe")
    )
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
  for (const failure of ["blob", "file", "main", "replacement", "pending", "check-pending", "check-source", "check-app", "check-missing", "check-link"]) {
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
  assert.ok(f.calls.length > 0);
});

test("verifies public Pages staging without a probe secret or Worker identity", async () => {
  const f = await fixture("staging", "", true);
  assert.deepEqual(
    await verifyRetainedPublication(f.input, undefined, f.fetcher),
    {
      artifactDigest: f.input.build.artifactDigest,
      deploymentId: f.input.deploymentId,
    },
  );
  for (const failure of ["blob", "file", "main", "replacement", "pending", "release-source"]) {
    const failed = await fixture("staging", failure, true);
    await assert.rejects(
      verifyRetainedPublication(failed.input, undefined, failed.fetcher),
      /PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED/,
    );
  }
});
