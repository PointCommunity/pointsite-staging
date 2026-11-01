import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const resolved = load.resolve("minimatch");
const patched = load(resolved);

// Preserve legacy ESLint plugin calls while using only the patched matcher.
load.cache[resolved].exports = Object.assign(patched.minimatch, patched, {
  // shortcut: ESLint's makeRe consumers use only .test; extend if another API is needed.
  makeRe(pattern, options) {
    const matcher = new patched.Minimatch(pattern, options);
    return { test: (path) => matcher.match(path) };
  },
});
