# Plan: #202 — re-test an unattributed Timeout once, alone, before scoring it killed

Base: main @ bdc66f6. Line numbers as of that commit.

## Today

- `runStryker` (`src/verify/index.ts:1911`): prepareIncrementalCache → one `runUnderLock` (`:2009`) → `recordOf` (`:1788`) → `strykerRunVerdict` (`:2119`, unrunSurvivedMutants + parseStrykerJson).
- Timeout is a kill because `stryker-adapter.ts:139` FAILING_STATUSES lists only Survived/NoCoverage.
- A measured Timeout never carries `killedBy` (stryker core mutation-test-report-helper writes status + statusReason only). "Unattributed" = `killedBy` absent/empty (same test as `incremental-cache.ts:346` vouchingTests).
- Two Timeout kinds: wall-clock, and `statusReason: "Hit limit reached (n/limit)"` (hit count — load cannot cause it).
- Cache keeps Timeout (`incremental-cache.ts:353` KEPT_STATUSES); stryker itself reuses a cached Timeout, so a re-test must drop the mutant from `reports/stryker-incremental.json` first.
- Stryker has no select-by-mutant-id; narrowest is `--mutate file:L1-L2`.

## Design

1. **One second stryker run for all selected Timeouts**, not one per mutant (each run = startup + full dry run; minutes in one adopter, #61).
   - Drop exactly the selected mutants from the incremental cache (stryker's key: file + range + mutatorName + replacement).
   - `stryker run --incremental --concurrency 1 --mutate <line ranges>` (ranges via existing `mutateEntries`, `mutate-ranges.ts:351`). Cache reuses every other mutant in the range; only the dropped ones are re-tested.
   - `--concurrency 1` = "alone": no sibling workers; the machine lock keeps other gates out. Run 2's own dry run re-measures the timeout from the project's settings (no override).
2. **Selection** (new pure module `src/verify/timeout-retest.ts`): in scope; `status === 'Timeout'`; no `killedBy`; not `Hit limit reached`; **measured this run** (not present as a Timeout in the cache written just before run 1). Stable order (file, line), first `limit`.
3. **Merge** `rescore(report1, report2, keys)`: replace each selected mutant's status/statusReason/testsCompleted with run 2's. Key missing, run 2 crashed/deferred/lock-timeout → keep Timeout, say so. Merged report goes through the existing verdict path, so a re-scored Survived becomes `stryker/survived`. Run 2's cache write needs no new code (repeat Timeout cached as kill; Survived dropped next run by dropUntrusted).
4. **Wiring** in `index.ts`: `retestTimeouts(context)` between the run and `strykerRunVerdict`, in its own function (complexity lint). Second `runUnderLock` on the same rung. `recordOf` refactored to read run 1's texts before run 2.
5. **Cap**: `mutationTimeouts.retestLimit`, default 10, 0 = off. New whole-number picker accepting 0 (`pickPositiveInteger` rejects 0). Threaded like `mutationCache.maxTracedModules` (config.ts, cli-core.ts, gate.ts, VerifyOptions).
6. **Detail**: progress lines
   - before: `guardrails: re-testing 3 of 7 timed-out mutants alone (at most 3: mutationTimeouts.retestLimit); 4 stay counted as killed.`
   - after: `guardrails: re-test: 2 timed out again (killed), 1 re-scored.`
   - `retested` / `rescored` added to the run-log StrykerRecord / StrykerPart / STRYKER_COUNTS.

## TDD steps

1. `test/verify/timeout-retest.test.ts`: selection cases (unattributed picked; killedBy / hit-limit / out-of-scope / pre-run-cached not; cap keeps first N stably).
2. Same: `retestMutate()` ranges; `dropMutants(cacheText, keys)` drops exactly those (helper beside `dropUntrusted`).
3. Same: `rescore()` — Timeout→Survived, Timeout stays, missing key stays Timeout.
4. `test/verify/timeout-retest-wiring.test.ts` (Done-when #1): fake exec, 2nd stryker call flips report to Survived; assert `--concurrency 1 --incremental --mutate`, cache lacked the mutant before call 2, verdict has `stryker/survived`.
5. Same (Done-when #2): run 2 Timeout again → no violation, cache keeps it; no candidate → one stryker call; run 2 crashed/deferred → kept + said so.
6. Progress text + `retested`/`rescored` in run record (mutation-run.test.ts, run-log.test.ts).
7. Config: default 10, 0 accepted, bad values fall back; cli-core pass-through.
8. Live drift (`test/drift/stryker-timeout.test.ts`): pin the Hit-limit statusReason string; add a real wall-clock hang (busy-wait on `Date.now()`) that stays killed through a real re-test, progress names 1 re-tested.
9. Docs: crushing-mutants SKILL.md (Timeout paragraph, lines ~50-58), docs/adoption.md (key), upgrades/unreleased.md (behaviour change: some former Timeouts can now block as survived; a run with timeouts may add one dry run; nothing to wire).

## Open questions (recommendation first)

1. Re-test only Timeouts measured this run, not cached/seeded ones? → yes (else every run re-pays a real hang).
2. Skip `Hit limit reached` Timeouts? → yes (load can't cause them).
3. Cap key/default? → `mutationTimeouts.retestLimit: 10`, 0 = off.
4. Rungs? → every rung that runs stryker; progress line announces the extra dry run.
5. Lock lost/busy between run 1 and run 2? → keep Timeouts as kills and say so.
6. Re-scored survivor's message notes it first timed out? → yes.
