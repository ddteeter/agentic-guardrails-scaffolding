# `guardrails ship`: no half-done ships — Implementation Plan

> One PR, one commit per task. Branch `fix/ship-prechecks`.

**Goal:** `ship` never leaves a pushed branch with no PR because of something it
could have checked first, and never reports `pr: null` for a branch that already
has a PR.

## Evidence

- **dialed.run #194:** `ship --body-file=<missing>` pushed through the full gate.
  Then `gh pr create --body-file` failed with "open <f>: no such file or
  directory", giving `state: error, pr: null` and a pushed branch with no PR.
  `ghUnavailable` (#129) already prevents the same outcome when `gh` is
  missing or not authenticated.
- **Deferred from #122:** when `git push` fails, `shipOutcome` returns
  `failure(...)`, which hardcodes `pr: null` even when the branch already has
  an open PR.

## Task 1 — Check `--body-file` before pushing

**Builds:** in `ship.ts`, next to `ghUnavailable`: when `options.bodyFile` is
set and not readable, return `failure('error', 'guardrails ship: --body-file
<f> does not exist (or is not readable). Nothing was pushed.')` before any
`git push`. The read goes through an injected seam, or the existing `fs` usage
in ship.ts, so tests need no real file.
**Tests (`test/ship.test.ts`):**

- a missing body file gives `error`, the message, and **no `git push` call**;
- a readable body file pushes as today;
- no `--body-file` behaves as today.

## Task 2 — A failed push still reports an existing PR

**Builds:** when the push fails (any `classifyPushFailure` state), look up
the branch's PR **read-only** (`gh pr view --json number,url`, the same
parse as `findOrOpenPullRequest`'s lookup, never `create`). Fill `pr`/`url`
when there is one, and keep `state` and `tail` as they are. If the lookup
fails, keep `pr: null`.
**Tests:**

- a gate-blocked push on a branch with a PR gives `gate-blocked` with
  `pr`/`url` set;
- the same with no PR gives `pr: null`;
- a failed lookup gives `pr: null` and does not change the state;
- **no `gh pr create`** is called on a failed push.

## Constraints

TDD; no suppressions, casts, `.skip` or weakened assertions; never
`--no-verify`; functions under fallow's thresholds (the `complexity`
analyzer is now on here); `node guardrails-core/dist/cli.mjs verify` must be
clean after `npm run build` before each commit.
