import assert from "node:assert/strict";
import test from "node:test";
import {
  deployWithReconciliation,
  isTransientDeployFailure,
  reconcileExpectedDeployment,
  type CommandRunner,
  deployPublicationWithProof,
} from "../scripts/deploy-staging.mts";

test("classifies only retryable Cloudflare and network deployment failures", () => {
  assert.equal(isTransientDeployFailure("503 Service Unavailable"), true);
  assert.equal(isTransientDeployFailure("HTTP 429 Too Many Requests"), true);
  assert.equal(isTransientDeployFailure("ECONNRESET by peer"), true);
  assert.equal(isTransientDeployFailure("uploaded 500 static assets"), false);
  assert.equal(
    isTransientDeployFailure("authentication failed: code 10000"),
    false,
  );
  assert.equal(isTransientDeployFailure("candidate checksum mismatch"), false);
});

test("requires native version identity and full traffic after a successful upload", async () => {
  const commitSha = "a".repeat(40);
  const candidateChecksum = "b".repeat(64);
  const version = "10000000-0000-4000-8000-000000000001";
  let percentage = 100;
  const run: CommandRunner = async (args) => ({
    exitCode: 0,
    output:
      args[1] === "deploy"
        ? "uploaded"
        : JSON.stringify(
            args[1] === "versions"
              ? [{ id: version, annotations: { "workers/tag": commitSha } }]
              : [
                  {
                    id: "deployment",
                    versions: [{ version_id: version, percentage }],
                  },
                ],
          ),
  });
  assert.equal(
    await deployPublicationWithProof({ commitSha, candidateChecksum, run }),
    version,
  );
  percentage = 50;
  await assert.rejects(
    deployPublicationWithProof({ commitSha, candidateChecksum, run }),
    /PUBLICATION_DEPLOYMENT_UNCONFIRMED/,
  );
});

test("reconciles only the expected tagged version at 100 percent traffic", () => {
  const versions = [
    { id: "old", annotations: { "workers/tag": "old-sha" } },
    { id: "expected", annotations: { "workers/tag": "commit-sha" } },
  ];
  const deployments = [
    { id: "old-deploy", versions: [{ version_id: "old", percentage: 100 }] },
    {
      id: "new-deploy",
      versions: [{ version_id: "expected", percentage: 100 }],
    },
  ];
  assert.deepEqual(
    reconcileExpectedDeployment(versions, deployments, "commit-sha"),
    { deploymentId: "new-deploy", versionId: "expected" },
  );
  assert.equal(
    reconcileExpectedDeployment(versions, deployments, "other-sha"),
    null,
  );
  assert.equal(
    reconcileExpectedDeployment(
      versions,
      [{ id: "split", versions: [{ version_id: "expected", percentage: 50 }] }],
      "commit-sha",
    ),
    null,
  );
});

test("turns an ambiguous post-deploy 503 into success without another upload", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "deploy")
      return { exitCode: 1, output: "GET /workers/subdomain -> 503" };
    if (args[1] === "versions")
      return {
        exitCode: 0,
        output: JSON.stringify([
          { id: "expected", annotations: { "workers/tag": "commit-sha" } },
        ]),
      };
    return {
      exitCode: 0,
      output: JSON.stringify([
        {
          id: "deployment",
          versions: [{ version_id: "expected", percentage: 100 }],
        },
      ]),
    };
  };
  const result = await deployWithReconciliation({
    commitSha: "commit-sha",
    candidateChecksum: "candidate-checksum",
    run,
    wait: async () => undefined,
    retryDelaysMs: [0],
  });
  assert.equal(result.status, "reconciled");
  assert.equal(calls.filter((item) => item.includes(" deploy ")).length, 1);
});

test("keeps confirmed deployment failures red without reconciliation", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args.join(" "));
    return { exitCode: 1, output: "authentication failed: code 10000" };
  };
  await assert.rejects(
    deployWithReconciliation({
      commitSha: "commit-sha",
      candidateChecksum: "candidate-checksum",
      run,
      wait: async () => undefined,
    }),
    /authentication failed/i,
  );
  assert.equal(calls.length, 1);
});

test("parses reconciliation JSON even when Wrangler emits a warning", async () => {
  const run: CommandRunner = async (args) => {
    if (args[1] === "deploy")
      return { exitCode: 1, output: "status: 503 Service Unavailable" };
    if (args[1] === "versions")
      return {
        exitCode: 0,
        output:
          "Wrangler warning\n[" +
          JSON.stringify({
            id: "expected",
            annotations: { "workers/tag": "commit-sha" },
          }) +
          "]\n",
      };
    return {
      exitCode: 0,
      output: JSON.stringify([
        {
          id: "deployment",
          versions: [{ version_id: "expected", percentage: 100 }],
        },
      ]),
    };
  };
  const result = await deployWithReconciliation({
    commitSha: "commit-sha",
    candidateChecksum: "candidate-checksum",
    run,
    wait: async () => undefined,
    retryDelaysMs: [0],
  });
  assert.equal(result.status, "reconciled");
});
