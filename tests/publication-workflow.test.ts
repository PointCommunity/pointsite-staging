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

for (const target of ["staging", "production"] as const)
  test(`${target} bootstrap reserves or finalizes only a Builder-verified native identity without exposing tokens`, async () => {
    const workflow = await readFile(
      new URL(
        `../.github/workflows/${target === "staging" ? "publish-runtime" : "publish-production-runtime"}.yml`,
        import.meta.url,
      ),
      "utf8",
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
    ]) {
      const revision = "a".repeat(40);
      const token = `fixture.${Buffer.from(JSON.stringify({ job_workflow_sha: revision })).toString("base64url")}.fixture`;
      const process = {
        exitCode: 0,
        env: {
          PUBLICATION_JOB_ID:
            failure === "job" ? "untrusted\ninput" : randomUUID(),
          PUBLICATION_NONCE: "b".repeat(64),
          PUBLICATION_OPERATION:
            failure === "finalize" ? "finalize" : "reserve",
          PUBLICATION_TARGET: failure === "target" ? "invalid" : target,
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
            `https://builder.pointatx.org/publish/${process.env.PUBLICATION_JOB_ID}/${process.env.PUBLICATION_NONCE}`,
          );
          return Response.json({
            value: failure === "oversized" ? "x".repeat(20_001) : token,
          });
        }
        assert.equal(parsed.origin, "https://builder.pointatx.org");
        assert.equal(
          parsed.pathname,
          `/api/publish/runner/${process.env.PUBLICATION_JOB_ID}/${process.env.PUBLICATION_OPERATION}`,
        );
        assert.equal(headers.get("authorization"), `Bearer ${token}`);
        assert.equal(init?.method, "POST");
        assert.equal(init?.body, undefined);
        return failure === "claim"
          ? new Response("private provider error", { status: 409 })
          : Response.json(
              failure === "finalize" ? { verified: true } : { reserved: true },
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
          "Publication identity or state rejected. No deployment authorized.",
        ]);
        if (["job", "target", "endpoint"].includes(failure))
          assert.equal(calls.length, 0);
      }
    }
  });
