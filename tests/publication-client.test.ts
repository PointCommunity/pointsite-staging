import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PublicationClient } from "../scripts/publication-client.mts";

const source = "a".repeat(40);
const environment = {
  BUILDER_ORIGIN: "https://builder.eaglepass.io",
  PUBLICATION_TARGET: "staging",
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://pipelines.actions.githubusercontent.com/oidc",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
};
// Transport fixtures only; cryptographic authorization is exercised against Builder's real verifier.
const tokenAt = (now = Date.now()) =>
  `fixture.${Buffer.from(JSON.stringify({ job_workflow_sha: source, exp: Math.floor(now / 1000) + 300 })).toString("base64url")}.fixture`;
const token = tokenAt();

test("renews an in-memory job token and sends only bounded requests to the fixed Builder origin", async (t) => {
  const job = randomUUID();
  const nonce = "b".repeat(64);
  const asset = randomUUID();
  let issuances = 0;
  let now = Date.now();
  let issued = tokenAt(now);
  t.mock.method(Date, "now", () => now);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.hostname === "pipelines.actions.githubusercontent.com") {
      issuances++;
      issued = tokenAt(now);
      assert.equal(
        url.searchParams.get("audience"),
        `https://builder.eaglepass.io/publish/${job}/${nonce}`,
      );
      return Response.json({ value: issued });
    }
    assert.equal(url.origin, "https://builder.eaglepass.io");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${issued}`,
    );
    assert.ok(url.pathname.startsWith(`/api/publish/runner/${job}/`));
    if (url.pathname.endsWith("/claim")) {
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, undefined);
      return Response.json({ claimed: true });
    }
    assert.equal(
      url.pathname,
      `/api/publish/runner/${job}/assets/${asset}/chunks/0`,
    );
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const client = new PublicationClient(
    job,
    nonce,
    source,
    environment,
    fetcher,
  );
  await client.claim();
  assert.deepEqual(await client.chunk(asset, 0), new Uint8Array([1, 2, 3]));
  assert.equal(issuances, 1);
  now += 241_000;
  await client.claim();
  assert.equal(issuances, 2);
});

test("rejects endpoint substitution, wrong checkout, oversized bytes and private provider errors", async () => {
  const job = randomUUID();
  const nonce = "b".repeat(64);
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ value: token });
  };
  for (const url of [
    "https://evil.example/oidc",
    "http://pipelines.actions.githubusercontent.com/oidc",
    "https://user@pipelines.actions.githubusercontent.com/oidc",
    "https://pipelines.actions.githubusercontent.com:8443/oidc",
  ]) {
    await assert.rejects(
      new PublicationClient(
        job,
        nonce,
        source,
        { ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: url },
        fetcher,
      ).claim(),
      /IDENTITY_UNAVAILABLE/,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    new PublicationClient(
      job,
      nonce,
      "c".repeat(40),
      environment,
      fetcher,
    ).claim(),
    /IDENTITY_UNAVAILABLE/,
  );
  for (const outcome of ["bytes", "error", "body"] as const) {
    const response: typeof fetch = async (input) => {
      if (
        new URL(input instanceof Request ? input.url : input).hostname.endsWith(
          ".actions.githubusercontent.com",
        )
      )
        return Response.json({ value: token });
      if (outcome === "bytes") return new Response(new Uint8Array(1_000_001));
      if (outcome === "body")
        return new Response("private-provider-response", { status: 500 });
      throw new Error("private-provider-credential");
    };
    await assert.rejects(
      new PublicationClient(job, nonce, source, environment, response).chunk(
        randomUUID(),
        0,
      ),
      (error: Error) =>
        /^PUBLICATION_(RESPONSE_TOO_LARGE|REQUEST_REJECTED)$/.test(
          error.message,
        ),
    );
  }
});

test("binds each mutation response to its requested phase and candidate commit", async () => {
  const commitSha = "c".repeat(40);
  const workerVersionId = randomUUID();
  const build = {
    candidateChecksum: "d".repeat(64),
    commitSha,
    treeSha: "e".repeat(40),
    manifestBlobSha: "f".repeat(40),
    artifactDigest: "1".repeat(64),
    fileCount: 1,
    totalBytes: 123,
  };
  const paths: string[] = [];
  let pages = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname.endsWith(".actions.githubusercontent.com"))
      return Response.json({ value: tokenAt() });
    const path = url.pathname.split("/").at(-1)!;
    paths.push(path);
    assert.equal(init?.method, "POST");
    if (path === "build" || path === "deployment") {
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "application/json",
      );
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        path === "build"
          ? build
          : pages
            ? { artifactDigest: build.artifactDigest }
            : { workerVersionId },
      );
    } else assert.equal(init?.body, undefined);
    return Response.json(
      path === "commit"
        ? { commitSha }
        : path === "deployment"
          ? { recorded: true }
          : { authorized: true },
    );
  };
  const client = new PublicationClient(
    randomUUID(),
    "a".repeat(64),
    source,
    environment,
    fetcher,
  );
  await client.authorizeBuild(build);
  await client.commitBuild(commitSha);
  await client.authorizeDeployment();
  await client.reportDeployment(workerVersionId);
  pages = true;
  await client.reportPagesDeployment(build.artifactDigest);
  assert.deepEqual(paths, [
    "build",
    "commit",
    "authorize-deployment",
    "deployment",
    "deployment",
  ]);
  await assert.rejects(client.commitBuild("b".repeat(40)));
});

test("verification uses a separate audience and only metadata endpoints", async () => {
  const job = randomUUID();
  const nonce = "b".repeat(64);
  const report = {
    artifactDigest: "c".repeat(64),
    deploymentId: "123",
    workerVersionId: randomUUID(),
  };
  const paths: string[] = [];
  let reports = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname.endsWith(".actions.githubusercontent.com")) {
      assert.equal(
        url.searchParams.get("audience"),
        `https://builder.eaglepass.io/verify/${job}/${nonce}`,
      );
      return Response.json({ value: tokenAt() });
    }
    assert.equal(url.origin, "https://builder.eaglepass.io");
    assert.ok(url.pathname.startsWith(`/api/publish/verification/${job}/`));
    const path = url.pathname.split("/").at(-1)!;
    paths.push(path);
    if (path === "claim") return Response.json({ claimed: true });
    if (path === "inputs")
      return Response.json({ retained: "public metadata" });
    assert.equal(path, "report");
    assert.deepEqual(JSON.parse(String(init?.body)), report);
    if (++reports === 1) throw new Error("private lost-response detail");
    return Response.json({ recorded: true });
  };
  const client = new PublicationClient(
    job,
    nonce,
    source,
    environment,
    fetcher,
    "verification",
  );
  await client.claim();
  assert.deepEqual(await client.verificationInputs(), {
    retained: "public metadata",
  });
  await client.reportVerification(report);
  assert.deepEqual(paths, ["claim", "inputs", "report", "report"]);
  await assert.rejects(
    client.authorizeDeployment(),
    /PUBLICATION_REQUEST_REJECTED/,
  );
  await assert.rejects(
    client.chunk(randomUUID(), 0),
    /PUBLICATION_REQUEST_REJECTED/,
  );
  assert.equal(paths.length, 4);
});

test("verification report retries stop after three identical requests", async () => {
  const bodies: unknown[] = [];
  const report = { artifactDigest: "c".repeat(64), deploymentId: "123" };
  const client = new PublicationClient(
    randomUUID(),
    "b".repeat(64),
    source,
    environment,
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname.endsWith(".actions.githubusercontent.com"))
        return Response.json({ value: tokenAt() });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("private provider detail", { status: 503 });
    },
    "verification",
  );
  await assert.rejects(
    client.reportVerification(report),
    /PUBLICATION_REPORT_REJECTED/,
  );
  assert.deepEqual(bodies, [report, report, report]);
  await assert.rejects(
    client.reportVerification({ ...report, deploymentId: "invalid" }),
  );
  const publisher = new PublicationClient(
    randomUUID(),
    "b".repeat(64),
    source,
    environment,
    async () => {
      throw new Error("Network must not be reached");
    },
  );
  await assert.rejects(
    publisher.verificationInputs(),
    /PUBLICATION_REQUEST_REJECTED/,
  );
  await assert.rejects(
    publisher.reportVerification(report),
    /PUBLICATION_REQUEST_REJECTED/,
  );
  assert.equal(bodies.length, 3);
});

test("rejects missing and substituted Builder origins and Canary Production callbacks", () => {
  for (const BUILDER_ORIGIN of [
    undefined,
    "https://builder.pointatx.org",
    "https://attacker.example",
    "https://builder.eaglepass.io/",
  ])
    assert.throws(
      () =>
        new PublicationClient(randomUUID(), "b".repeat(64), source, {
          ...environment,
          BUILDER_ORIGIN,
        }),
    );
  assert.throws(
    () =>
      new PublicationClient(randomUUID(), "b".repeat(64), source, {
        ...environment,
        BUILDER_ORIGIN: "https://builder-canary.eaglepass.io",
        PUBLICATION_TARGET: "production",
      }),
  );
});
