import assert from "node:assert/strict";
import test from "node:test";
import { authorizeStagingRequest } from "../worker/index";

const env = {
  BUILDER_ORIGIN: "https://builder.pointatx.org",
  STAGING_PROBE_SECRET: "probe-secret-at-least-32-characters",
  ASSETS: { fetch: () => Promise.resolve(new Response("asset")) },
};

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
      headers: { cookie: "__Secure-pointsite_builder_session=signed-value; preference=compact" },
    }),
    env,
    (input, init) => {
      assert.equal(input, "https://builder.pointatx.org/api/me");
      forwardedCookie = new Headers(init?.headers).get("cookie") ?? "";
      return Promise.resolve(new Response("ok"));
    },
  );
  assert.equal(allowed, null);
  assert.equal(forwardedCookie, "__Secure-pointsite_builder_session=signed-value");
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
