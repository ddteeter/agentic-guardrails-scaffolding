# #198 — on ci-red, tell "rebase and re-ship" from "re-run the failed jobs"; add `--rerun-failed`

## Today (guardrails-core/src/ship.ts)

- `ShipState`: green | gate-blocked | lock-timeout | ci-red | behind | conflicting | error.
  `ShipStatus` → `.guardrails/state/ship-status.json`; no in-repo reader (lanes and
  people read it, per docs/adoption.md ~932-960, ~1085-1100).
- `baseCheck` already refuses a branch behind `origin/<base>` before the push, so
  "main moved" on ci-red can only arise during the gate/CI wait.
- `parseRuns` (#205) keeps the latest run per workflow+event by `databaseId`, then
  discards the id (`ship.ts:285`) — the ids a re-run needs.
- Base branch comes from `--base` → PR base → `config.baseBranch`; nothing hardcoded.
- Tests seam all git/gh through `Exec` (`fakeExec` in `test/ship.test.ts`).

## Traps

1. `--fail-fast` fires while the failing run is still in progress (`conclusion ''`);
   GitHub won't re-run an incomplete run → map the failing check's `workflow` to its
   run and `gh run watch` it first.
2. A re-run keeps its `databaseId` and bumps `attempt`; watch only after the attempt
   advances, or the old failure reports ci-red instantly.
3. `startup_failure` and never-reported required checks have nothing to re-run.
4. Never parse ids from check `link` URLs; only `gh run list` `databaseId`.

## Design

- `state` stays `ci-red`. New always-present field
  `diagnosis: { base: 'contains'|'moved'|'unknown'; rerunnable: number[];
advice: 'rebase'|'rerun-failed'|'fix'; next: string } | null` (null unless ci-red).
- Advice from evidence only: base moved → `rebase`; else non-empty `rerunnable` →
  `rerun-failed`; else `fix`. Ship never says "flaky"; at most "origin/<base> has
  not moved since this commit was tested".
- Post-CI probe uses the pushed sha, not HEAD. Fetch failure → `base: 'unknown'` +
  warning, never changes the state.
- `--rerun-failed` is a separate invocation; re-derives targets from a fresh
  `gh run list` for HEAD (doesn't trust the status file); refuses if HEAD ≠ the
  pushed commit, no PR, nothing re-runnable, or base moved. Then rerun → wait for the
  attempt to advance (bounded) → `watchChecks` → fresh diagnosis.

## TDD steps (red → green → touched test files + gate each)

1. `parseRuns` keeps `id`, `status`, `attempt`; `--json` adds `status,attempt`;
   malformed rows dropped.
2. Extract `baseContainment(options, commit)` from `baseCheck`; #178 tests unchanged.
3. `diagnoseRed` after a ci-red watch (8 cases: moved→rebase, base name from config
   incl. `trunk`, probe on sha, rerunnable ids, fetch failure → unknown, fix-only,
   fail-fast in-progress mapping via check `workflow`, link ids ignored, null on
   other states and no fetch on green). `readChecks` adds `workflow`.
4. `shipSummary` prints `next: …` from `diagnosis.next` (exact strings).
5. `rerunOutcome` for `--rerun-failed` (10 cases incl. watch-before-rerun, attempt
   never advancing → error, red again → fresh diagnosis, run-log row).
6. CLI flag + `SHIP_USAGE` / `SHIP_HELP` (`cli-core.ts`).
7. Docs (`docs/adoption.md` ship paragraph + lanes list) and `upgrades/unreleased.md`
   ("Behaviour that changed" + `supersedes` on `gh run rerun` / `gh run watch`).

## Decisions (owner)

Decided 2026-11-23.

- Q1: any base movement → advice `rebase`. No base-sensitive-checks config.
- Q2: `--rerun-failed` with a moved base refuses, no re-run, state `behind`;
  widen `behind`'s doc text beyond "decided before the push".
- Q3: offered only; never re-run automatically.
- Q4: additive `diagnosis` field; `state` stays `ci-red`.
- Green-but-BEHIND: separate follow-up issue (filed by the coordinator), not here.

## Risks

- Older gh without `pr checks --json workflow`: fall back without it (lose only the
  in-progress mapping), tested.
- Re-run races and multi-event workflows: each target's attempt must advance.
- `cancelled` (superseded) runs must stay filtered out of rerun targets.
- `watchChecks`, `shipOutcome`, `baseCheck` near the complexity cap: extract.
