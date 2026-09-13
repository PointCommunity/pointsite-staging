import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { checksumDocument } from "../site-kit/canonicalize";
import {
  verifyPublicationOutput,
  verifyPublicationOutputWithRetry,
} from "../scripts/publication-live.mts";

test("live convergence retries complete read-only proofs at most three times", async () => {
  const body = "Fixture";
  const files = [
    {
      path: "index.html",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  ];
  const input = {
    target: "production" as const,
    files,
    artifactDigest: await checksumDocument(files),
    candidateChecksum: "a".repeat(64),
    workflowRevision: "b".repeat(40),
  };
  for (const unavailable of [2, 3]) {
    let identities = 0;
    let fileReads = 0;
    const delays: number[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(init?.method, undefined);
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      if (String(url).endsWith("/__pointsite_release.json")) {
        if (++identities <= unavailable)
          return new Response("private failure", { status: 503 });
        return Response.json({
          format: 2,
          artifactDigest: input.artifactDigest,
          candidateChecksum: input.candidateChecksum,
          workflowRevision: input.workflowRevision,
        });
      }
      fileReads++;
      return new Response(body);
    };
    const result = verifyPublicationOutputWithRetry(
      input,
      fetcher,
      async (delay) => {
        delays.push(delay);
      },
    );
    if (unavailable === 3) {
      await assert.rejects(
        result,
        /^Error: PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED$/,
      );
      assert.equal(identities, 3);
      assert.equal(fileReads, 0);
    } else {
      assert.equal((await result).filesVerified, 1);
      assert.equal(identities, 4);
      assert.equal(fileReads, 1);
    }
    assert.deepEqual(delays, [2_000, 5_000]);
  }
});

test("verifies every output hash between matching native release identities with scoped probe headers", async () => {
  const contents = new Map([
    ["about/index.html", "<html>Fixture</html>"],
    ["index.html", "<html>Home</html>"],
  ]);
  const files = [...contents].map(([path, body]) => ({
    path,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  }));
  const input = {
    target: "staging" as const,
    files,
    artifactDigest: await checksumDocument(files),
    candidateChecksum: "a".repeat(64),
    workflowRevision: "b".repeat(40),
    workerVersionId: randomUUID(),
    probeSecret: "fixture-probe-secret-".repeat(3),
  };
  for (const failure of [
    "",
    "identity",
    "bytes",
    "headers",
    "anonymous",
    "redirect",
  ]) {
    let identities = 0;
    const requests: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      requests.push(parsed.pathname);
      assert.equal(parsed.origin, "https://staging.pointatx.org");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      if (parsed.pathname === "/__pointsite_release.json") {
        identities++;
        assert.equal(headers.has("X-PointSite-Staging-Probe"), false);
        return Response.json({
          format: 2,
          candidateChecksum: input.candidateChecksum,
          workflowRevision: input.workflowRevision,
          artifactDigest: input.artifactDigest,
          workerVersionId:
            failure === "identity" && identities > 1
              ? randomUUID()
              : input.workerVersionId,
        });
      }
      if (!headers.has("X-PointSite-Staging-Probe"))
        return new Response("Sign in", {
          status: failure === "anonymous" ? 200 : 401,
        });
      assert.equal(headers.get("X-PointSite-Staging-Probe"), input.probeSecret);
      const content = contents.get(
        parsed.pathname === "/" ? "index.html" : "about/index.html",
      )!;
      return new Response(failure === "bytes" ? "changed" : content, {
        status: failure === "redirect" ? 302 : 200,
        headers:
          failure === "headers"
            ? {}
            : {
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
              },
      });
    };
    if (failure)
      await assert.rejects(
        verifyPublicationOutput(input, fetcher),
        /PUBLICATION_LIVE_VERIFICATION_UNCONFIRMED/,
      );
    else {
      assert.deepEqual(await verifyPublicationOutput(input, fetcher), {
        filesVerified: 2,
        artifactDigest: input.artifactDigest,
      });
      assert.deepEqual(requests, [
        "/",
        "/__pointsite_release.json",
        "/about/",
        "/",
        "/__pointsite_release.json",
      ]);
    }
  }
});

test("verifies public Pages output without credentials and preserves HTML file paths", async () => {
  const contents = new Map([
    ["404.html", "<html>Missing</html>"],
    ["about/index.html", "<html>About</html>"],
    ["index.html", "<html>Home</html>"],
  ]);
  const files = [...contents].map(([path, body]) => ({
    path,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  }));
  const input = {
    target: "production" as const,
    files,
    artifactDigest: await checksumDocument(files),
    candidateChecksum: "a".repeat(64),
    workflowRevision: "b".repeat(40),
  };
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    assert.equal(parsed.origin, "https://pointatx.org");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(
      new Headers(init?.headers).has("X-PointSite-Staging-Probe"),
      false,
    );
    requests.push(parsed.pathname);
    if (parsed.pathname === "/__pointsite_release.json")
      return Response.json({
        format: 2,
        artifactDigest: input.artifactDigest,
        candidateChecksum: input.candidateChecksum,
        workflowRevision: input.workflowRevision,
      });
    const path =
      parsed.pathname === "/"
        ? "index.html"
        : parsed.pathname === "/about/"
          ? "about/index.html"
          : parsed.pathname.slice(1);
    assert.ok(contents.has(path));
    return new Response(contents.get(path), {
      status: path === "404.html" ? 404 : 200,
    });
  };
  assert.deepEqual(await verifyPublicationOutput(input, fetcher), {
    filesVerified: 3,
    artifactDigest: input.artifactDigest,
  });
  assert.deepEqual(requests, [
    "/__pointsite_release.json",
    "/404.html",
    "/about/",
    "/",
    "/__pointsite_release.json",
  ]);
});
