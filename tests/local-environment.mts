import { before, after } from "node:test";

// Transport fixtures exercise both destinations independently of the CI host repository.
// The destination and workflow suites explicitly test real Actions identity rejection.
const actions = process.env.GITHUB_ACTIONS;
before(() => { delete process.env.GITHUB_ACTIONS; });
after(() => {
  if (actions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = actions;
});
