import assert from "node:assert/strict";
import "./local-environment.mts";
import { test } from "node:test";
import { publicationDestination } from "../scripts/publication-destination.mts";

test("one publication runtime binds each Builder to its own repository and site", () => {
  assert.deepEqual(publicationDestination("staging", "https://builder-canary.eaglepass.io"), {
    repository: "pointsite-staging-canary", origin: "https://staging-canary.pointatx.org",
  });
  assert.deepEqual(publicationDestination("staging", "https://builder.eaglepass.io"), {
    repository: "pointsite-staging", origin: "https://staging.pointatx.org",
  });
  assert.deepEqual(publicationDestination("production", "https://builder-canary.eaglepass.io"), {
    repository: "pointsite-canary", origin: "https://canary.pointatx.org",
  });
  assert.throws(() => publicationDestination("staging", "https://attacker.invalid"));
  const previous = { actions: process.env.GITHUB_ACTIONS, repository: process.env.GITHUB_REPOSITORY };
  try {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite-staging";
    assert.throws(() => publicationDestination("staging", "https://builder-canary.eaglepass.io"));
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite-staging-canary";
    assert.throws(() => publicationDestination("staging", "https://builder.eaglepass.io"));
    assert.equal(publicationDestination("staging", "https://builder-canary.eaglepass.io").repository, "pointsite-staging-canary");
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite";
    assert.throws(() => publicationDestination("production", "https://builder-canary.eaglepass.io"));
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite-canary";
    assert.throws(() => publicationDestination("production", "https://builder.eaglepass.io"));
    assert.equal(publicationDestination("production", "https://builder-canary.eaglepass.io").repository, "pointsite-canary");
  } finally {
    for (const [name, value] of [["GITHUB_ACTIONS", previous.actions], ["GITHUB_REPOSITORY", previous.repository]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
