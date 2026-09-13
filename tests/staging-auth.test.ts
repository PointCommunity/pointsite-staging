import assert from "node:assert/strict";
import test from "node:test";
import worker, { authorizeStagingRequest } from "../worker/index";

const env = {
  BUILDER_ORIGIN: "https://builder.pointatx.org",
  STAGING_PROBE_SECRET: "probe-secret-at-least-32-characters",
  ASSETS: { fetch: () => Promise.resolve(new Response("asset")) },
};

test("exposes only validated release hashes and native version while keeping all content protected", async () => {
  const release = {
    format: 2,
    candidateChecksum: "a".repeat(64),
    artifactDigest: "b".repeat(64),
    workflowRevision: "c".repeat(40),
  };
  const version = "10000000-0000-4000-8000-000000000001";
  let reads = 0;
  const configured = {
    ...env,
    CF_VERSION_METADATA: { id: version },
    ASSETS: {
      fetch: async (request: Request) => {
        reads++;
        assert.equal(
          new URL(request.url).pathname,
          "/__pointsite_release.json",
        );
        assert.equal(request.headers.get("cookie"), null);
        assert.equal(request.headers.get("X-PointSite-Staging-Probe"), null);
        return Response.json(release);
      },
    },
  };
  const request = new Request(
    "https://staging.pointatx.org/__pointsite_release.json",
    {
      headers: {
        cookie: "__Secure-pointsite_builder_session=fixture",
        "X-PointSite-Staging-Probe": "fixture",
      },
    },
  );
  const response = await worker.fetch(request, configured);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...release,
    workerVersionId: version,
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  for (const path of [
    "/",
    "/assets/image.png",
    "/__pointsite_release.json?path=/assets/image.png",
  ]) {
    assert.equal(
      (
        await worker.fetch(
          new Request(`https://staging.pointatx.org${path}`),
          configured,
        )
      ).status,
      401,
    );
  }
  assert.equal(reads, 1);
  for (const bytes of [
    JSON.stringify({ ...release, secret: "private-fixture" }),
    "private-fixture",
    "x".repeat(1025),
  ]) {
    const failed = await worker.fetch(request, {
      ...configured,
      ASSETS: { fetch: async () => new Response(bytes) },
    });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /private-fixture|secret/);
  }
  assert.equal(
    (
      await worker.fetch(request, {
        ...configured,
        CF_VERSION_METADATA: undefined,
      })
    ).status,
    503,
  );
});

test("denies anonymous staging requests and validates signed sessions through the Builder", async () => {
  let forwardedCookie = "";
  const denied = await authorizeStagingRequest(
    new Request("https://staging.pointatx.org/"),
    env,
    () => Promise.resolve(new Response("denied", { status: 401 })),
  );
  assert.ok(denied);
  assert.equal(denied.status, 401);
  assert.match(await denied.text(), /href="https:\/\/builder\.pointatx\.org"/);
  assert.match(denied.headers.get("content-type") ?? "", /text\/html/);

  const allowed = await authorizeStagingRequest(
    new Request("https://staging.pointatx.org/", {
      headers: {
        cookie:
          "__Secure-pointsite_builder_session=signed-value; preference=compact",
      },
    }),
    env,
    (input, init) => {
      assert.equal(input, "https://builder.pointatx.org/api/me");
      forwardedCookie = new Headers(init?.headers).get("cookie") ?? "";
      return Promise.resolve(new Response("ok"));
    },
  );
  assert.equal(allowed, null);
  assert.equal(
    forwardedCookie,
    "__Secure-pointsite_builder_session=signed-value",
  );
});

test("allows the CI probe secret without creating a public authentication bypass", async () => {
  const result = await authorizeStagingRequest(
    new Request("https://staging.pointatx.org/", {
      headers: { "X-PointSite-Staging-Probe": env.STAGING_PROBE_SECRET },
    }),
    env,
    () => {
      throw new Error("Builder should not be called for the scoped probe");
    },
  );
  assert.equal(result, null);

  const wrong = await authorizeStagingRequest(
    new Request("https://staging.pointatx.org/", {
      headers: { "X-PointSite-Staging-Probe": "wrong" },
    }),
    env,
    () => Promise.resolve(new Response("denied", { status: 401 })),
  );
  assert.ok(wrong);
  assert.equal(wrong.status, 401);
});
