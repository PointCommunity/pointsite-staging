import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

await import("../tools/eslint-minimatch.mjs");
const load = createRequire(import.meta.url);

test("locks every Minimatch implementation to a patched release", async () => {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  let implementations = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    const info = entry as { name?: string; version?: string };
    if (!info.version || (!path.endsWith("/minimatch") && info.name !== "minimatch"))
      continue;
    const [major, minor, patch] = info.version.split(".").map(Number);
    assert.ok(
      major > 11 || (major === 11 && (minor > 0 || patch >= 1)),
      `${path}@${info.version} is vulnerable to GHSA-g3hv-75wg-m249`,
    );
    implementations++;
  }
  assert.ok(implementations > 0, "No patched Minimatch implementation found");
});

test("ESLint consumers share patched callable, named and matcher interfaces", () => {
  const matching = load("minimatch");
  for (const consumer of [
    "eslint",
    "@eslint/config-array",
    "@eslint/eslintrc",
    "@typescript-eslint/typescript-estree",
    "eslint-plugin-import",
    "eslint-plugin-react",
    "eslint-plugin-jsx-a11y",
  ]) {
    const fromConsumer = createRequire(load.resolve(consumer));
    assert.equal(fromConsumer("minimatch"), matching, consumer);
  }
  assert.equal(matching("app/page.tsx", "**/*.{ts,tsx}"), true);
  assert.equal(matching("app/page.js", "**/*.{ts,tsx}"), false);
  assert.equal(matching(".hidden.ts", "*.ts"), false);
  assert.equal(matching(".hidden.ts", "*.ts", { dot: true }), true);
  assert.equal(matching("test.ts", "!*.js"), true);
  assert.equal(matching.minimatch("PAGE.TSX", "*.tsx", { nocase: true }), true);
  assert.equal(new matching.Minimatch("app/**").match("app/page.tsx"), true);
  const matcher = matching.makeRe("private/**");
  assert.equal(matcher.test("private/secret"), true);
  assert.equal(matcher.test("public/allowed"), false);
});

test("patched glob matching preserves import, React and accessibility enforcement", async () => {
  const { ESLint } = await import("eslint");
  const lint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.jsx"],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: {
        import: load("eslint-plugin-import"),
        react: load("eslint-plugin-react"),
        "jsx-a11y": load("eslint-plugin-jsx-a11y"),
      },
      rules: {
        "import/no-internal-modules": ["error", { forbid: ["private/**"] }],
        "react/jsx-pascal-case": ["error", { ignore: ["Legacy_*"] }],
        "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["Field*"] }],
      },
    }],
  });
  const [result] = await lint.lintText([
    'import secret from "private/secret";',
    "export default () => <>",
    "  <Legacy_widget /><Wrong_widget />",
    "  <label>Caption<FieldInput /></label>",
    "  <label>Orphan</label>",
    "</>;",
  ].join("\n"), { filePath: "app/lint-regression.jsx" });
  assert.equal(result.fatalErrorCount, 0);
  assert.deepEqual(result.messages.map((message) => message.ruleId).sort(), [
    "import/no-internal-modules",
    "jsx-a11y/label-has-associated-control",
    "react/jsx-pascal-case",
  ]);
});
