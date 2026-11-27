# Plan #236 step 3a — `stats` you can trust across projects

The lane copies this file to `docs/superpowers/plans/2026-11-26-236-3a-project-stats.md`.

## Why

`guardrails stats` (0.18.2) reads a run log that every project on the machine shares. Each row's `repo` is the worktree's folder name (gate-run-log.ts:110, :165, :231), so each lane counts as its own repo. In the field data this mixed an 11s-dry-run suite with a 10-minute one, and the depth/load tables made that mix look like contention.

Separately, a skipped or "off" seed records no reason (prepare-cache.ts:512, :518). That leaves 16 of the cold starts unexplained.

## Decisions

- **Project identity.**
  - Take `git rev-parse --git-common-dir`, resolved against repoRoot.
  - If its basename is `.git`, use the parent folder's basename. Otherwise strip a trailing `.git`, which covers bare repos and submodules (`.git/modules/lib` gives `lib`).
  - If git fails, fall back to `path.basename(repoRoot)`.
  - The result is always a basename, never a path. Every worktree of one clone gets the same name.
- **Row schema.** Add an optional `project?` to RowBase (run-log.ts:121). Readers use `projectOf(row) = row.project ?? row.repo`.
  - **Do not bump `v`.** `baseOf` rejects `v !== 1` (run-log.ts:379), and other projects may pin older guardrails against the same log.
- **Cache part.** Add `seedWhy?` to CachePart and CacheOutcome, set only when the seed is `skipped` or `off`. `why` keeps its current meaning, so today's tally keys don't split.
- **Sync writers.** `logLockRun` and `logShipRun` are sync, so `project` is computed before them, the same way `branch` is (command-lock.ts:542, ship.ts:1901).

## TDD steps (failing test first in each)

1. `projectName(exec, repoRoot)` in gate-run-log.ts, next to `branchOf`.
   - Fake-exec cases: `/x/main/.git` gives `main`; a relative `.git`; `/x/foo.git` gives `foo`; `.git/modules/lib` gives `lib`; a failure gives `basename(repoRoot)`; the result never contains a path separator.
   - One real-git test (new `test/project-name-git.test.ts`): `git worktree add`, then both checkouts give the same name. Strip GIT_* (pattern in test/verify/diff-base-git.test.ts:34-44).
2. The gate row carries `project` (extend gate-run-log.test.ts:126).
3. Lock and ship rows carry `project`: add it to LockRunInput and ShipRunInput, computed at command-lock.ts:542 and ship.ts:1901.
4. `parseRuns` round-trip: a row with `project` keeps it; a row without it parses unchanged; a non-string `project` is dropped and the row kept; `v` stays 1.
5. Seed reasons.
   - Replace `canUseSeed` with `seedSkipReason(): string | undefined`, one early return per cause: no per-test coverage; any-test-change; a support file wired to every test; no import graph.
   - For `off`, return `'mutationCache.seedFrom is not set'` or `'no installed stryker to fingerprint this checkout'`.
   - Pass `seedWhy` through `prepareIncrementalCache`, `cacheOf` (run-log.ts:324) and mutation-run.ts:93.
6. `stats --project=<name>`: add `StatsWindow.project` and filter on `projectOf` (run-stats.ts:249-256). Wire it in cli-core.ts:2446 and the usage line (:2544). Both a legacy row and a lane row match.
7. Per-project summary: `RunStats.projects` = `[{project, runs, legacy, byDepth, byLoad}]`, most runs first.
   - Print `projects: main 300, small 39 (n row(s) predate project identity)`.
   - With more than one project in the window, print the depth/load tables per project and drop the mixed ones. `--json` keeps the mixed tables.
   - Test fixture: a small and a large suite give two tables with the right medians.
8. Cold-start tally.
   - `coldReason` (run-stats.ts:138): with no `why` but a `seedWhy`, the key is `local cache none, seed skipped: <seedWhy>`.
   - Add `RungSummary.seedNotTried`, printed as `    seed skipped 9×: <reason> 5, <reason> 4`. A legacy row shows `reason not recorded`.
9. Docs.
   - docs/adoption.md:1206-1235: add the `project` field, `--project`, the per-project tables, `seedWhy`, and a note that `stats` output names projects.
   - upgrades/unreleased.md, "Behaviour that changed": what rows record now, `stats --project` and the per-project tables, `seedWhy`, and that the log stays at v1. "What to wire": nothing.
   - Done when `guardrails verify` and the drift guards are green.

## Defaults (each recommended, and approved unless the owner says otherwise)

- Separate clones of one remote stay separate projects. A remote-name grouping comes later, only if data calls for it.
- With more than one project in the window, hide the mixed depth/load tables (they stay in `--json`).
- No hashing of project names. Document that `stats` output names projects.
- `seedWhy` names the cause, not the file.
- Keep `--repo`, documented as the worktree folder name.
