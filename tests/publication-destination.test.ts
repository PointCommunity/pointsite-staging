import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationDestination } from "../scripts/publication-destination.mts";

test("one publication runtime binds each Builder to its own repository and site", () => {
  assert.deepEqual(publicationDestination("staging", "https://builder-canary.eaglepass.io"), {
    repository: "pointsite-staging-canary", origin: "https://staging-canary.pointatx.org",
  });
  assert.deepEqual(publicationDestination("staging", "https://builder.eaglepass.io"), {
    repository: "pointsite-staging", origin: "https://staging.pointatx.org",
  });
  assert.throws(() => publicationDestination("production", "https://builder-canary.eaglepass.io"));
  assert.throws(() => publicationDestination("staging", "https://attacker.invalid"));
  const previous = { actions: process.env.GITHUB_ACTIONS, repository: process.env.GITHUB_REPOSITORY };
  try {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite-staging";
    assert.throws(() => publicationDestination("staging", "https://builder-canary.eaglepass.io"));
    process.env.GITHUB_REPOSITORY = "PointCommunity/pointsite-staging-canary";
    assert.throws(() => publicationDestination("staging", "https://builder.eaglepass.io"));
    assert.equal(publicationDestination("staging", "https://builder-canary.eaglepass.io").repository, "pointsite-staging-canary");
  } finally {
    for (const [name, value] of [["GITHUB_ACTIONS", previous.actions], ["GITHUB_REPOSITORY", previous.repository]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
