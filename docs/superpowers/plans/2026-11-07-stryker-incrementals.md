# Stryker incrementals: #156 → #155 → #157

**Goal:** make the push gate's mutation run take time in proportion to the
change, not to the files it touched, and stop a re-ship from starting cold.
The plan was reviewed with dialed.run's wave 3 coordinator on 2026-11-07, and
its critiques are folded in.

- **#156:** rewrite the incremental cache instead of deleting it. Keep
  verdicts that are still valid and re-test the rest.
- **#155:** mutate only the changed line ranges, not whole files.
- **#157:** seed a fresh worktree's cache from the base branch's CI reports.
- **Signal work** (the comment on #156): keep stryker's partial report when a
  gate is stopped.

## Decisions (settled with Drew)

- **Everything is configurable, and the defaults are the safest setting that
  does not throw away valid results.** The settings live under a new
  `mutationCache` key in `guardrails.config.json`, plus `mutationScope` for the
  line ranges.
- **Cache reuse (#156).** The default is `invalidation: "targeted"`:
  - Survived and NoCoverage results are always dropped, which closes
    stryker-js#6119 (the static-mutant limitation).
  - A Killed or Timeout result is kept only if every test that killed it sits in
    a test file this branch has not changed **at all**. Changed means any
    change since the base branch, or newer than the cache. Removed lines are not
    the test, because a test can be weakened by adding lines.
  - A Killed or Timeout result whose killing test cannot be traced to a file is
    dropped.
  - If any changed file is test-support code (neither production nor a test,
    such as `test-utils.ts`, mocks, `vitest.setup.ts` or snapshots), the whole
    cache is discarded.
  - The whole cache is also discarded when the fingerprint changes (stryker
    version, the stryker config hash, or the lockfile hash) or when the cache
    cannot be parsed.
  - An opt-in `invalidation: "any-test-change"` discards everything whenever any
    test file changed. That is today's behaviour, kept for consumers who want
    it.
- **Line ranges (#155).** `mutationScope.lines` is on by default, with
  configurable padding and a whole-file threshold. The defaults lean wide:
  `padding: 5` and `wholeFileAbove: 0.4`. Both values get checked against
  measurements in Task 2.1.
- **Seeding (#157)** is opt-in through `mutationCache.seedFrom`, a shell command.
  A **sample** GitHub workflow ships in the docs only; nothing is scaffolded.
  The sample keeps artifact retention short (1 to 3 days, newest only).
- **Known gap, to be documented:** an edit in file A can change whether a
  mutant in an untouched file B is killed, and nothing at the gate re-checks B.
  CI's whole-scope mutation run is the backstop, so the gate is not a complete
  measurement. This is true before and after this work.

## Constraints

- TDD throughout. Pre-validate example code against the house lint rules
  (complexity, boolean comparisons, abbreviations).
- Analyzer invocations stay consumer-generic. No hardcoded `gh`, no repo
  paths.
- **dialed.run:** fixtures only until the coordinator reports a quiet window.
  Do not take `~/.guardrails-gate.lock`, run no heavy stryker while `lockf` is
  live, and do not bump guardrails-core there until wave 3 closes.
- Each new config key gets a `config.test.ts` case, a default, and a
  `docs/` entry.

---

## Phase 0: ground truth (drift tests first)

These pin down how real stryker behaves before we build on it. They go in
`guardrails-core/test/drift/`, next to `stryker-incremental.test.ts`.

**0.1 Report shape.** Run a fixture through real stryker with the vitest
runner. Assert that the incremental report carries `killedBy` test ids that
resolve to `testFiles[file].tests[].id`, and that each test has a file (stryker
10.1, #6188).
_Done:_ the test passes, and records which fields the rewriter may rely on.

**0.2 Reproduce #67 / #6119.** A module-level (static) schema mutant survives
run 1. Add a killing test, and run 2 under today's `--incremental` with the
cache kept reports it as Survived again. This test documents the upstream bug.
Phase 1's version of it must report Killed.
_Done:_ the bug reproduces on stryker 10.1.1.

**0.3 Ranges and incremental.** Run with `--mutate "a.ts:10-20"`, with a cache
that holds survivors outside 10–20 in the same file. Assert whether stryker
folds those survivors back into the written report.
_Done:_ the behaviour is pinned, and Task 2.3 is designed against it.

**0.4 Signals.** Run stryker under the gate's real spawn chain (`lockf -k -s -t`
plus the resolved bin, through `runUnderLock`). Send one SIGINT, then one to
the process group. Record how many signals stryker receives and whether the
partial `reports/stryker-incremental.json` is written (#5986, #6257).
_Done:_ a finding in plan.md's fixer-loop-hardening section, and Phase 4 is
scoped from it.

## Phase 1: #156, rewrite the cache

**1.1 `incremental-cache.ts`, pure parse and model.** A parser for the cache
(the mutation-testing-report schema) that rejects unknown shapes, with a
validator at the boundary and no `as` casts. Its output maps each file to its
mutants and each test id to a test file.
_Test:_ unit tests for valid, malformed and partial reports. _Done:_ the parser
is fully covered and its mutants are killed.

**1.2 `filterToScope(cache, files)`.** Drop files outside this run's mutate set
instead of rejecting the whole cache (critique B). It replaces the subset rule
in `canReuseIncrementalCache`; the per-test-coverage rule stays.
_Test:_ a cache with in-scope and out-of-scope files keeps only the in-scope
ones; a cache with no `coveredBy` anywhere is still rejected.

**1.3 `dropUntrusted(cache, changedTestFiles)`.** The targeted rule:

- drop Survived and NoCoverage;
- drop Killed and Timeout when any killing test's file is in
  `changedTestFiles`;
- drop Killed and Timeout when a killing test does not resolve.

_Test:_ one case per branch, including a test file changed only by added lines.

**1.4 Fingerprint sidecar.** Write `reports/stryker-incremental.fingerprint.json`
holding the stryker version, the config hash and the lockfile hash (critique
on deps). When it does not match, the whole cache is discarded, and a missing
sidecar counts as not matching. Add the sidecar path to the scaffold's ignore
list (`scaffold/merge.ts`).
_Test:_ change each of the three inputs in turn and check that the cache is
discarded.

**1.5 Discard-all triggers.** A changed test-support file discards everything,
and so does `invalidation: "any-test-change"` when a test changed. Classify
files with `isTestFile`, `isConfigFile` and the production predicates from
`git.ts`.
_Test:_ the trigger matrix.

**1.6 Wire into `runStryker`.** Replace `discardUnusableIncrementalCache` with
read → fingerprint check → filter → drop → write (or delete). Remove
`haveTestsChangedSinceCache` and its mtime seam only if nothing else uses them;
otherwise keep them as the "newer than cache" half of `changedTestFiles`.
_Test:_ the existing `run-stryker` tests are updated; drift test 0.2 now
reports Killed. _Done:_ a green `npm run test:coverage`, and stryker on the
changed files leaves no survivors.

**1.7 Config plus docs.** Add `mutationCache.invalidation` to `RepoConfig` and
`config.test.ts`, and document it, including the known gap above.

## Phase 2: #155, line-range mutate

**2.1 Hunk parser.** Turn `git diff --unified=0 <base>` output, merged with the
working tree the same way `git.ts` already merges it, into per-file line ranges.
Pure function over the diff text.
_Test:_ fixtures for added, deleted and renamed files, pure deletions (a zero
count becomes the line around the cut), overlapping hunks, and CRLF line
endings.
_Measured (2026-11-07):_ stryker's instrumenter over the modified files of
three ranges of this repo's history (`main..stryker-incremental-cache`,
`main~10..main`, `main~30..main~10`), without the whole-file threshold.
Padding 5 tested 3.8%, 14.5% and 39.0% of the whole-file mutants and included
83.0%, 89.5% and 97.0% of the mutants overlapping a changed line. Padding 2
included 83.0–95.6%, padding 10 89.4–98.6% at 5.7–46.9% of the cost. The misses
are mutants spanning the hunk (function-body `BlockStatement`s), which no small
padding reaches. Defaults kept: `padding: 5`, `wholeFileAbove: 0.4`.

**2.2 Range planner.** From ranges, `padding`, `wholeFileAbove` and the file's
line count, produce `--mutate` entries (`file:a-b`, with several per file) or
the whole file. New files are always whole. The `!` negations are appended as
today.
_Test:_ table-driven cases, including merging ranges that touch after padding.

**2.3 Verdict filters by range.** `parseStrykerJson` and `unrunSurvivedMutants`
also drop mutants whose location falls outside the planned ranges, so cached
out-of-range survivors cannot block. Shape this after what drift test 0.3
found.
_Test:_ a report with an out-of-range survivor yields no violation.

**2.4 Wire it in, plus config.** Pass the planned entries as `--mutate`. The
pre-push lock probe (`strykerScope`) must agree with it. Add `mutationScope`
config and docs.
_Test:_ `run-stryker` asserts the argument vector. _Done:_ a fixture branch
with a one-line change to a 300-line file mutates only that region.

## Phase 3: #157, seeding

**3.1 Report merge in core.** `mergeReports(reports)` takes several files or a
directory and returns the union of `files` and `testFiles`. It fails closed
(no seed) when a production file appears in two inputs.
_Test:_ disjoint merge, overlapping files rejected, one malformed input
rejected.

**3.2 `seedFrom` runner.** When no local cache exists, run the configured
command with `GUARDRAILS_SEED_DIR` set and a timeout (default 120 s,
configurable). Merge whatever lands there and write it as the cache, with a
fingerprint computed from this checkout. Everything after that is the Phase 1
pipeline. On failure, timeout or no output, run cold and print one line on
stderr saying why.
_Test:_ success, failure, timeout and empty output, each through injected
`exec`.

**3.3 Sample workflow plus docs.** A documented sample: a CI mutation job that
uploads `reports/stryker-incremental.json` with `actions/upload-artifact`
(`retention-days: 2`), and a `seedFrom` command that uses
`gh run download --name …` from the newest successful base-branch run. Note
that `actions/cache` contents cannot be downloaded outside a run, so consumers
need the artifact step.
_Done:_ the docs are reviewed. Nothing is scaffolded.

## Phase 4: keep partial reports on stop

Scoped by finding 0.4. The likely shape:

**4.1** If stryker gets two signals, `runUnderLock` traps SIGINT and SIGTERM
and forwards exactly one SIGINT to stryker.

**4.2** On the gate's own timeout or lock loss, send stryker SIGINT and allow a
grace period before SIGKILL (critique D: the 1h40m loss).

**4.3** The next run treats a partial cache like any other: fingerprint, filter,
drop.

_Test:_ injected-process tests, plus one drift test with real stryker.
_Done:_ stopping a fixture gate leaves a parseable partial cache, and the next
run reuses its Killed results.

## Phase 5: validate and release

- **5.1** Measure on fixtures: re-ship after an edit to a test in place, and a
  one-line change to a large file. Record the times in the PR body.
- **5.2** After the coordinator's quiet window: one `--mutate` run against a
  dialed.run scratch worktree on a local build, with no gate lock and no
  version bump there.
- **5.3** Update plan.md's roadmap section and close #155, #156 and #157 from
  the PRs.

**PR split:** Phase 0 with Phase 1; Phase 2; Phase 3; Phase 4. Each ships on its
own through `guardrails ship`.
