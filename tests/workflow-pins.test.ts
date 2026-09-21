import assert from "node:assert/strict";
import test from "node:test";
import { verifyWorkflowPins } from "../scripts/verify-workflow-pins.mts";

test("runtime pins survive PR branch cleanup only with matching retained tags", () => {
  const publication = "a".repeat(40), verification = "b".repeat(40);
  const caller = (name: string, sha: string) =>
    `    uses: PointCommunity/pointsite-staging/.github/workflows/${name}.yml@${sha}\n`;
  const workflows = [caller("publish-runtime", publication), caller("verify-runtime", verification)];
  const tag = (sha: string) => `${sha}\trefs/tags/runtime/${sha}\n`;

  assert.equal(verifyWorkflowPins(workflows, tag(publication) + tag(verification)), 2);
  assert.equal(verifyWorkflowPins([
    workflows[0].replace("uses: ", "uses: '").trimEnd() + "'\n",
  ], `${verification}\trefs/tags/runtime/${publication}\n${publication}\trefs/tags/runtime/${publication}^{}\n`), 1);
  assert.throws(() => verifyWorkflowPins(workflows, ""), /matching protected runtime/);
  assert.throws(() => verifyWorkflowPins(workflows, tag(publication)), /verify-runtime/);
  assert.throws(() => verifyWorkflowPins(workflows,
    `${verification}\trefs/tags/runtime/${publication}\n` + tag(verification)), /publish-runtime/);
  assert.throws(() => verifyWorkflowPins([caller("publish-runtime", "main")], ""), /full commit SHA/);
  assert.throws(() => verifyWorkflowPins([], ""), /No canonical reusable workflow pins/);
});
