# Plan: #200 — measure, then (maybe) restrict the push-gate dry run

Base: main @ 87cd8fe. Stryker 10.0.0, vitest-runner 10.0.0.

## Findings that reshape #200 (spot-checked)

- **The dry run is already related-only by default.** `vitest.related` defaults to `true` (`vitest-runner/dist/schema/vitest-runner-options.json:18-21`), and `dryRun` passes the mutated files as `relatedFiles` (`vitest-test-runner.js:98-107`). The cost that scales with the suite is vitest's related-graph walk: `getTestDependencies` transforms every spec's import graph. That walk, plus each related file's environment, setup, import and collect, runs serially on **one worker** (`maxWorkers: 1`, `:52`). Upstream #6311 / PR #6312 (`dryRunMaxWorkers`, open) targets the serial part.
- **`--testFiles` exists, but risks false survivors.** Any test filter forces `mutantActivation: 'runtime'` (`core/mutants/mutant-test-planner.js:42-46,147`). Runtime activation sets the mutant in `beforeAll`, after module-level code has already run, so **static mutants could falsely Survive**. This is a reading of the code and needs a live check.
- Covering tests aren't computed before launch today; `importersOf` (`verify/importing-tests.ts`) can do it transitively and answers `undefined` when unsure.
- `dryRunMs` today includes stryker startup + instrumenting + runner init; #236's `dryRunNetMs`/`dryRunOverheadMs` are the real dry-run numbers.

## Proposed scope for THIS lane: steps 0–3 (measure + spike)

0. **Live spike** `test/drift/stryker-related-dry-run.test.ts`:
   - Fixture: a target with a runtime mutant and a static one; 6 test files (2 reach the target, one of them transitively through a helper; 4 don't, each with a ~300 ms top-level await).
   - Run real stryker with and without `--testFiles`.
   - Pins: (a) how much `dryRunOverheadMs` shrinks; (b) whether the static mutant falsely survives under `--testFiles`; (c) that verdicts otherwise match. The guard records both answers either way, so it also tells us when stryker fixes (b).
1. **Dry-run counts in the summary:** tests run and distinct test files (counts only), from `onDryRunCompleted`.
2. **Per-mutant tallies from `onMutantTested`** (this run's work only, not reused mutants):
   - Σ `testsCompleted`;
   - counts by mutator × status;
   - Σ and count of `coveredBy` (for the mean);
   - count of static mutants.

   Malformed events are skipped, never thrown.

3. **`stats`:** dry-run share of held time, tests per gate, and the by-mutator table. This is the per-type picture of time.

Docs and `unreleased.md` (additive, nothing to wire). Privacy: counts and Stryker's mutator names only; no test names or paths.

## Deferred until step 0 + field data (a second plan)

4–8: a pure scope planner (`planDryRunScope`, with fallbacks: no resolver or `undefined` importers, a truncated corpus, an in-scope file with no importing test, ≥ 0.8 of the corpus, a consumer `testFiles`, glob metacharacters, a non-vitest runner); wiring `--testFiles`; **escalation** (in a restricted run, re-run each Survived/NoCoverage once with no filter before reporting); the `mutationDryRun: 'full'|'related'` knob; and the full live guard.

- **Why defer:** with `related` already on, the gain is only the graph walk over unrelated specs. The static-mutant hazard adds an escalation path. If upstream `dryRunMaxWorkers` lands, it may be the cheaper lever (a Stryker bump plus one option).

## Open questions (recommendation first)

1. Limit this lane to steps 0–3 and decide 4–8 on the spike's numbers → yes.
2. If the spike confirms static mutants falsely survive under `--testFiles` → file it with stryker-js (ask before filing) and pin it in the guard.
3. Bump Stryker to 10.1.x first (it likely brings per-mutant `duration`, #6252) → a separate small task, not this lane.
