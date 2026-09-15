import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import test from "node:test";

test("the public entrypoint accepts only a captured job and pins the reusable implementation", async () => {
  const caller = await readFile(
    new URL("../.github/workflows/publish-candidate.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    caller,
    /^  repository_dispatch:\n    types: \[publish-candidate\]/m,
  );
  assert.match(
    caller,
    /^    uses: PointCommunity\/pointsite-staging\/\.github\/workflows\/publish-runtime\.yml@[a-f0-9]{40}$/m,
  );
  assert.match(caller, /^      target: staging$/m);
  assert.match(
    caller,
    /job_id: \$\{\{ github\.event\.client_payload\.jobId \}\}/,
  );
  assert.match(
    caller,
    /nonce: \$\{\{ github\.event\.client_payload\.nonce \}\}/,
  );
  assert.doesNotMatch(caller, /^  (push|workflow_dispatch):|secrets: inherit/m);
  assert.match(caller, /^run-name: Publish Staging candidate /m);
});

for (const purpose of ["publication", "verification", "rollback"] as const)
  for (const target of (purpose === "rollback"
    ? ["production"]
    : ["staging", "production"]) as ("staging" | "production")[])
    for (const canary of target === "staging" ? [false, true] : [false])
    test(`${canary ? "Canary" : "Production"} Builder ${target} ${purpose} bootstrap reserves or finalizes only a Builder-verified native identity without exposing tokens`, async () => {
      const workflow = await readFile(
        new URL(
          `../.github/workflows/${purpose === "rollback" ? "rollback-runtime" : purpose === "verification" ? "verify-runtime" : target === "staging" ? "publish-runtime" : "publish-production-runtime"}.yml`,
          import.meta.url,
        ),
        "utf8",
      );
      if (purpose === "verification") {
        assert.doesNotMatch(
          workflow,
          /contents: write|pages: write|CLOUDFLARE|upload-artifact|deploy-pages|npm run build/,
        );
        assert.equal(workflow.match(/deployment: false/g)?.length, 3);
        assert.match(workflow, /persist-credentials: false/);
        assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
      }
      if (purpose === "publication") {
        assert.match(workflow, /pages: write/);
        assert.match(workflow, /actions\/upload-pages-artifact@[a-f0-9]{40}/);
        assert.match(workflow, /retention-days: 1/);
        assert.match(workflow, /actions\/deploy-pages@[a-f0-9]{40}/);
        assert.doesNotMatch(workflow, /CLOUDFLARE|STAGING_PROBE_SECRET/);
        assert.ok(
          workflow.indexOf("publication-run.mts authorize-pages") <
            workflow.indexOf("uses: actions/deploy-pages"),
        );
        assert.ok(
          workflow.indexOf("uses: actions/deploy-pages") <
            workflow.indexOf("publication-run.mts verify-pages"),
        );
      }
      assert.match(workflow, /concurrency:\n  group: pointsite-pages-/);
      assert.match(workflow, /cancel-in-progress: false/);
      assert.doesNotMatch(
        workflow,
        /builder\.pointatx\.org|STAGING_PROBE_SECRET/,
      );
      const body = workflow
        .split("  BOOTSTRAP_JS: |\n")[1]
        .split("\njobs:")[0]
        .split("\n")
        .map((line) => line.slice(4))
        .join("\n");
      const source = body.replace(
        "import { appendFile } from 'node:fs/promises';",
        "",
      );
      const script = new Script(`(async () => { ${source} })()`);
      for (const failure of [
        "",
        "finalize",
        "job",
        "target",
        "endpoint",
        "claim",
        "oversized",
        "builder",
        "repository",
        ...(target === "production" ? ["canary"] : []),
      ]) {
        const revision = "a".repeat(40);
        const token = `fixture.${Buffer.from(JSON.stringify({ job_workflow_sha: revision })).toString("base64url")}.fixture`;
        const process = {
          exitCode: 0,
          env: {
            BUILDER_ORIGIN:
              failure === "builder"
                ? "https://attacker.example"
                : failure === "canary" || canary
                  ? "https://builder-canary.eaglepass.io"
                  : "https://builder.eaglepass.io",
            PUBLICATION_JOB_ID:
              failure === "job" ? "untrusted\ninput" : randomUUID(),
            PUBLICATION_NONCE: "b".repeat(64),
            PUBLICATION_OPERATION:
              failure === "finalize" ? "finalize" : "reserve",
            PUBLICATION_TARGET: failure === "target" ? "invalid" : target,
            GITHUB_REPOSITORY: failure === "repository" ? "PointCommunity/wrong" : target === "production" ? "PointCommunity/pointsite" : canary ? "PointCommunity/pointsite-staging-canary" : "PointCommunity/pointsite-staging",
            ACTIONS_ID_TOKEN_REQUEST_URL:
              failure === "endpoint"
                ? "https://evil.example"
                : "https://pipelines.actions.githubusercontent.com/oidc",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-private-request-token",
            GITHUB_OUTPUT: "fixture-output",
          },
        };
        const calls: string[] = [],
          outputs: string[] = [],
          errors: string[] = [];
        const fetcher: typeof fetch = async (url, init) => {
          const parsed = new URL(url instanceof Request ? url.url : url);
          calls.push(parsed.href);
          assert.equal(init?.redirect, "error");
          const headers = new Headers(init?.headers);
          if (parsed.hostname.endsWith(".actions.githubusercontent.com")) {
            assert.equal(
              headers.get("authorization"),
              "Bearer fixture-private-request-token",
            );
            assert.equal(
              parsed.searchParams.get("audience"),
              `${process.env.BUILDER_ORIGIN}/${purpose === "verification" ? "verify" : purpose === "rollback" ? "rollback" : "publish"}/${process.env.PUBLICATION_JOB_ID}/${process.env.PUBLICATION_NONCE}`,
            );
            return Response.json({
              value: failure === "oversized" ? "x".repeat(20_001) : token,
            });
          }
          assert.equal(parsed.origin, process.env.BUILDER_ORIGIN);
          assert.equal(
            parsed.pathname,
            `/api/publish/${purpose === "verification" ? "verification" : purpose === "rollback" ? "rollback-runner" : "runner"}/${process.env.PUBLICATION_JOB_ID}/${process.env.PUBLICATION_OPERATION}`,
          );
          assert.equal(headers.get("authorization"), `Bearer ${token}`);
          assert.equal(init?.method, "POST");
          assert.equal(init?.body, undefined);
          return failure === "claim"
            ? new Response("private provider error", { status: 409 })
            : Response.json(
                failure === "finalize"
                  ? { verified: true }
                  : { reserved: true },
              );
        };
        await script.runInNewContext({
          process,
          fetch: fetcher,
          URL,
          TextDecoder,
          Buffer,
          AbortSignal,
          appendFile: async (file: string, text: string) => {
            assert.equal(file, "fixture-output");
            outputs.push(text);
          },
          console: { error: (text: string) => errors.push(text) },
        });
        if (!failure || failure === "finalize") {
          assert.equal(process.exitCode, 0);
          assert.equal(calls.length, 2);
          assert.deepEqual(outputs, [`source=${revision}\n`]);
          assert.deepEqual(errors, []);
        } else {
          assert.equal(process.exitCode, 1);
          assert.deepEqual(outputs, []);
          assert.deepEqual(errors, [
            purpose === "verification"
              ? "Verification identity or state rejected."
              : "Publication identity or state rejected. No deployment authorized.",
          ]);
          if (
            ["job", "target", "endpoint", "builder", "canary"].includes(failure)
          )
            assert.equal(calls.length, 0);
        }
      }
    });
