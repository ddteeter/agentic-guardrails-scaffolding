# #197 — a test-support change drops only its importers' cached results

## Today

- `src/verify/prepare-cache.ts` `admissible()` returns `undefined` when any
  changed file `isTestSupportFile` — both modes, local cache and seed. The seed
  then reports the wrong reason ("it holds no per-test coverage").
  `canUseSeed()` skips fetching the seed outright.
- Under `targeted`, `trusted()` calls `dropUntrusted(cache, changedTests)`
  (`src/verify/incremental-cache.ts`): drops every Killed/Timeout whose
  vouching test file is in the set. The seed path does the same with
  `changedFiles`. **The change reduces to adding "cached test files that
  import a changed support file" to those sets.**
- `createImportResolver` (`src/import-graph.ts`) fails OPEN for this purpose:
  a TS throw returns `[]`, unresolved specifiers vanish, `coveringTests` is one
  hop only, `readTestCorpus` truncates silently. So: reuse the TS resolver
  underneath, add a strict tracer and a separate transitive closure.

## Design

1. **Seam** `CacheSeams.importersOf(supportFiles, testFiles) →
Promise<Map<support, Set<test>> | undefined>`. Absent / throws / `undefined`
   → refuse everything (today's behaviour). TS loaded only when a support file
   changed.
2. **Wired-to-every-test files are never traced** — new `isWiredToEveryTest`
   in `src/verify/git.ts`: setup-named files, `isConfigFile`, `.snap`,
   `__mocks__/`, non-JS/TS files (e.g. `fixtures/*.json`), a changed support
   file that no longer exists. → refuse everything.
3. **Zero importers → refuse everything** (it reaches tests some way the graph
   can't see: `setupFiles` under another name, automock, `fs` read). No
   config reading.
4. **Strict tracer** `createImportTracer(repoRoot, load?)` → `string[] |
undefined`; `undefined` on a TS throw or any unresolved non-built-in
   specifier. `createImportResolver` unchanged.
5. **New `src/verify/importing-tests.ts`**: pure `importersOf(...)` BFS with
   memoised reachability, cycle-safe, each module read once, cap
   (`MAX_TRACED_MODULES` ≈ 5000) → `undefined`. `createImportersOf(repoRoot,
load?)` wires the tracer + `repoSourceReader`. Test list comes from the
   cache's own `testFiles` — layout-generic, no directory walk.
6. `any-test-change` behaviour unchanged.

## TDD steps (red → green → touched test files + gate each)

1. `isWiredToEveryTest` classifier (`test/verify/test-roles.test.ts`); split
   private `isTestSupportName`. Existing `isTestSupportFile` tests untouched.
2. `createImportTracer` fails closed (`test/import-graph.test.ts`); existing
   resolver tests pass unmodified.
3. Transitive closure (`test/verify/importing-tests.test.ts`): direct, two-hop,
   cycle, non-importer absent, unreadable/untraceable/cap → `undefined`, read
   once; one real-TS tmp-repo case with a `paths` alias.
4. **Issue test 1:** helper change imported by `a.test.ts` only → `src/a.ts`
   kills dropped, `src/b.ts` kept, `local: 'kept'`
   (`test/verify/prepare-cache.test.ts`). `admissible` stops checking support
   files under `targeted`; new `supportImpact(seams, run, cache)`.
5. **Issue test 2:** setup file → discarded without calling the seam;
   zero-importer helper → discarded; helper imported by every test → all kills
   dropped, cache kept.
6. **Issue test 3:** seam returns `undefined` / rejects / absent → discarded.
7. `any-test-change` pinned: helper change still discards, seam not called.
8. Seed path: `canUseSeed` fetches under `targeted` when no changed support
   file is wired-to-every-test and the seam exists; `withSeed` runs
   `supportImpact` against the seed's test files (extract `trustedSeed()`).
9. Refusal reasons naming the file and cause (#176 run log); fix the seed's
   misleading reason.
10. Wiring: `src/verify/index.ts` passes `importersOf:
createImportersOf(repoRoot)`; `test/mutation-cache-wiring.test.ts` +
    fixture gain a second test and a one-importer helper, real TS via symlinked
    `node_modules/typescript`.
11. Docs: `docs/adoption.md` (~l.341, ~l.419), `mutationCache` doc comment in
    `src/config.ts`; `upgrades/unreleased.md` "Behaviour that changed" bullet
    - `supersedes` entry for adopter notes telling agents to avoid touching
      helpers.

## Decisions (owner)

Approved 2026-11-23.

- Q1 unresolved non-built-in specifiers: **fail closed** (refuse everything).
- Q2 a `setupFiles` entry some tests also import: **document the gap** in
  `docs/adoption.md`; follow-up issue to ask the runner for its resolved setup
  list. No config text search.
- Q3 specific refusal reasons naming file + cause: **yes** (step 9).
- Q4 this branch's changed spec files that exist on disk count as importers:
  **yes**.
- Q5 tracing cap: **configurable**, default 5000, beside the existing
  `incremental.invalidation` setting (positive integer, validated like its
  siblings, documented in `src/config.ts` + `docs/adoption.md`). Past it →
  refuse everything.
- Q6 snapshot → owning-spec mapping: **follow-up issue**, out of scope.

## Risks

- Imports TS can't see (`import(\`...\`)`, `require(variable)`, reading `.ts`
  as text) only caught by the zero-importer rule. Documented.
- Cost: traces every module reachable from cached tests; memoised, capped,
  runs only when a support file changed.
- `testFiles` keys are repo-root-relative; tracer must resolve from repo root,
  not `process.cwd()`.
- Lint: cognitive complexity ≤ 15 (split `withSeed`, `reusableCache`), no
  boolean compare, no abbreviations, no trailing `undefined` arg.
