---
version: unreleased
supersedes:
  - search: 'test-support'
    because: 'if it tells agents to avoid editing test helpers, fixtures or `test-utils` so the mutation cache survives, a changed helper module now costs only the cached kills of the tests that import it; setup files, configs, mocks, snapshots and data fixtures still discard the whole cache'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **A test-support change drops only its importers' cached kills (#197).**
  Under the default `mutationCache.invalidation: "targeted"`, a changed helper
  or fixture module under a test directory, or a `test-utils` module, no
  longer discards the whole mutation cache and seed. The gate traces the
  import graph with the repo's own TypeScript and drops the kills of the tests
  that import the changed file, directly or through other modules, and keeps
  the rest. The whole cache is still discarded for a file that reaches tests
  without an import (a setup file, a runner config, `__mocks__`, a snapshot, a
  non-JS/TS fixture), for a helper no test imports, and whenever the graph
  cannot be traced: no TypeScript, an import that resolves to nothing, or a
  trace past `mutationCache.maxTracedModules` modules (new, default 5000).
  `any-test-change` is unchanged.
- **A discarded cache or refused seed names the file and the cause** in the
  run log, such as `test/helpers.ts changed, and no test imports it`. A seed
  is no longer refused as "it holds no per-test coverage" when the real cause
  was a test-support change.

## Instructions this supersedes

- **"Avoid touching test helpers, fixtures or `test-utils` so the push gate
  stays warm"**, or any rule that routes a fix around a shared helper for the
  cache's sake: drop it. A helper change now costs only the kills of the tests
  that import it. Keep such a rule only for setup files, runner configs,
  mocks, snapshots and data fixtures, which still discard the whole cache.
