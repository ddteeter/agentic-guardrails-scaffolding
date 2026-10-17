# `complexity` analyzer — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.
> One PR, one commit per task.

**Goal:** catch a function that goes over fallow's complexity thresholds **in
the commit that pushes it over**, not at pre-push. Today, only the pre-push
`check:graph` (`fallow --fail-on-issues`) enforces fallow's health thresholds.
The commit-rung `sonarjs/cognitive-complexity` uses the same limit (15) but
counts differently.

**Branch:** `feat/complexity-analyzer` (worktree `~/dev/projects/guardrails-complexity`).

## Evidence (verified 2026-10-17)

- **#122 incident:** a fix commit raised `runCommitGate` to cyclomatic 18 /
  cognitive 16. Every commit gate passed, and ESLint's sonarjs rule did not
  flag it. The pre-push gate then failed on `fallow health` (cognitive >
  15), which cost a full push cycle.
- **fallow 3.0.0 defaults:** `max_cyclomatic_threshold: 20` and
  `max_cognitive_threshold: 15`, both read from the repo's own fallow config.
- **`fallow health --complexity --format json --quiet`:**
  - runs in about 0.6 s over this repo (4,406 functions);
  - exits **1 when there are findings** and 0 when there are none;
  - each finding is `{ path, name, line, col, cyclomatic, cognitive,
line_count, exceeded, severity, actions[] }`;
  - `exceeded` is one of `cyclomatic | cognitive | both | crap |
cyclomatic_crap | cognitive_crap | all`;
  - `summary` carries the thresholds that applied.
- **CRAP:** when `coverage/coverage-final.json` exists, fallow picks it up and
  also reports CRAP. At the commit rung that coverage is stale or absent, so
  CRAP is not a sound commit-time signal.
- **Rule ids** in `node_modules/fallow/issue-registry.json`:
  `fallow/high-cyclomatic-complexity`, `fallow/high-cognitive-complexity`,
  `fallow/high-complexity` (both) and `fallow/high-crap-score`.
- **fallow's suggested suppression:** `// fallow-ignore-next-line complexity`.
  `audit.ts` already watches `fallow-ignore[-next-line|-line|-file]`, so a
  fixer that suppresses instead of refactoring is caught.

## Decisions

1. **New analyzer `complexity`** with provider `fallow` and `minRung: 'commit'`,
   so it also runs at push and ci. It is a separate tool rather than an
   extension of `dupes`, so an adopter can enable either one alone.
2. **Default mode `off`** (an entry in `DEFAULT_MODES`), for the reason
   recorded for `dupes`: under `auto`, every consumer without fallow would get
   a `silentlySkippedAnalyzers` nag for a tool they never asked for. This repo
   sets it to `required` in `guardrails.config.json`. Having `init` enable it
   automatically when fallow is declared is a follow-up (filed as an issue,
   not built here).
3. **Only cyclomatic and cognitive are reported.** A finding whose `exceeded`
   is `crap` is dropped. For `cyclomatic_crap`, `cognitive_crap` and `all`,
   only the complexity part is reported. CRAP stays a pre-push / CI concern,
   where coverage is fresh.
4. **Config-agnostic invocation:** `fallow health --complexity --format json
--quiet`, with no thresholds, `--config` or paths. fallow reads the
   adopter's own thresholds and `health.ignore`, so the commit rung and
   pre-push agree by construction.
5. **Diff scoping in the adapter, as `dupes` does:** keep findings whose
   `path` is in the changed-file set. As with ESLint at commit, a touched file's
   pre-existing over-limit function is reported. This is documented under
   Known limits. Line-level scoping is a possible follow-up.
6. **Exit-code handling:** exit 1 means findings, not a crash. The runner
   reports `analyzer-failed` only when the process was killed, or when the exit
   code is non-zero and stdout is not a parseable health report. The check
   runs on the unfiltered report, so findings that exist but all fall outside
   the diff cannot read as a crash.
7. **Rule ids:** `exceeded: cyclomatic` maps to
   `fallow/high-cyclomatic-complexity`, `cognitive` to
   `fallow/high-cognitive-complexity`, and `both`/`all` to
   `fallow/high-complexity`. The `*_crap` values map to their complexity half.
   The `fallow/` prefix is already in `LOOSE_PREFIXES`, so these route to the
   thorough fixer. That is deliberate: where to split is judgment, and the
   tempting mechanical "fix" fallow itself offers is a suppression. A test
   pins this.
8. **Violation shape:** `fixable: false`, severity `error`, located at the
   function's line. The message names the function and both scores against
   the thresholds from `summary`, and says to extract helpers rather than
   suppress.

## Global constraints

TDD (failing test first); no suppressions, casts, `.skip` or weakened
assertions; zero runtime deps; `unicorn/prevent-abbreviations` naming;
functions under fallow's own thresholds (run `npx fallow health --complexity`
before each commit). Each task ends with `node guardrails-core/dist/cli.mjs
verify` clean after `npm run build`, and is committed through the normal
gate. The analyzer invocation stays config-agnostic and layout-generic.

---

## Task 1 — Adapter: `parseFallowHealthJson`

**Builds:** `parseFallowHealthJson(stdout, changedFiles): { violations,
isReport }` in `verify/fallow-adapter.ts`, next to the dupes parser. It has a
shape guard for the report and for each finding, maps `exceeded` to a rule id,
drops CRAP-only findings, filters to `changedFiles`, and builds the message.
`isReport` tells the runner whether stdout parsed.
**Tests (`test/verify/fallow-adapter.test.ts`):**

- each `exceeded` value maps to the right rule id;
- `crap` is dropped;
- a finding outside the changed set is dropped;
- a malformed finding is skipped, and the rest are kept;
- malformed JSON gives `isReport: false` and no violations;
- the message carries the name, scores and thresholds.
  **Done:** green, and no mutation survivors.

## Task 2 — Default mode and registry entry

**Builds:**

- `DEFAULT_MODES.complexity = 'off'`, with its rationale;
- `runComplexity` and its `ANALYZERS` entry (`tool: 'complexity'`,
  `provider: 'fallow'`, `minRung: 'commit'`, `scope: 'changed-files'`);
- exit handling per Decision 6.
  `fallow` is already a peer dependency through `dupes`.
  **Tests:**
- `analyzer-policy.test.ts`: the default is `off`, and an explicit setting
  wins.
- `orchestrator.test.ts` with a stubbed exec:
  - `required` spawns exactly `fallow health --complexity --format json
--quiet` and surfaces the violation;
  - unset never spawns it;
  - exit 1 with a report whose findings are all outside the diff gives no
    violations and no `analyzer-failed`;
  - exit 2 with garbage gives `analyzer-failed`;
  - a killed process gives `analyzer-failed`.
- Rung tests: not run at stop, run at commit, push and ci.
  **Done:** green, and no survivors.

## Task 3 — Loose classification pinned, and drift guards

**Builds and tests:**

- `loose-rules.test.ts` asserts the three ids are loose.
- `test/drift/registry.test.ts` adds the three ids to the fallow
  `knownIds` (each must still exist and be `free`).
- New `test/drift/complexity-runner.test.ts`: real `fallow health` over a
  temp-dir fixture holding one over-threshold function and one simple one,
  through `parseFallowHealthJson`. It asserts exactly one violation, on the
  complex function, and that the exit code is 1. It builds the fixture in a
  temp dir as `dupes-runner.test.ts` does, so this repo's own fallow/eslint
  never see it.
  **Done:** green.

## Task 4 — Turn it on here, then docs

**Builds:**

- `guardrails.config.json`: `"complexity": "required"`.
- `docs/adoption.md`: add the analyzer to the cadence and scope table, how to
  enable it, the CRAP exclusion, and the Known limit from Decision 5.
- README analyzer list.
- `plan.md`: record the #122 finding, which closes the "fallow only at
  pre-push" gap, and the init-auto-enable follow-up.
  **Done:** verify is clean with the analyzer actually running (confirm it is
  not in the silently-skipped list), and `npx fallow health` reports 0 above
  threshold.

## Verification

From the worktree, stage an edit that raises a function's cognitive
complexity to 16 or more, then run `guardrails gate --mode=commit`. Expect a
`fallow/high-cognitive-complexity` block. Revert the edit. Record the output
in the PR body.
