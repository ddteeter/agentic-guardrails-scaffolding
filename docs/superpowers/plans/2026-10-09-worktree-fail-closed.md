# Worktree fail-closed and fixer-lock hardening — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.
> One PR, one commit per task.

**Goal:** close the fail-open paths and fixer-scope gaps that two weeks of
dialed.run transcripts (2026-09-25 → 10-09: one coordinator session plus ~190
subagents, most of them in nested `.claude/worktrees/*` checkouts) surfaced. All
three hosts we target (Claude Code, Codex, GitHub Copilot) are covered.

**Branch:** `fix/worktree-fail-closed`.

## Evidence (verified, not inferred)

| #   | Finding                                                                                                                                                                                                                                                                                            | How it was verified                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | A **commit-rung fixer is never scope-locked**. `collectManifestScope` activates only `<session>.last.json` + `<session>.pre-fix.json`; the commit gate writes `<session>-commit.last.json` and no marker.                                                                                          | Reproduced against the built CLI: as `guardrail-fixer`, Edit of `guardrails.config.json` → allowed with only a commit manifest present, denied once a stop manifest + marker exist. Transcript: a commit-rung fixer edited `guardrails.config.json` (2026-09-26T18:40).                                                                                                                                                |
| F2  | **CLI resolved from an ancestor (nested worktree without `node_modules`) exits 1 for every command.** Claude and Codex treat exit 1 as non-blocking, so every gate is silently skipped. Copilot treats a non-zero pre-tool exit as a **deny**, so on Copilot the same case denies every tool call. | `cli-core.ts` `runCommand` → `outsideRepoMessage` → `return 1`. ~1,000 "resolved from … which is outside …" hook errors across ~45 dialed.run agents; one `git commit --no-verify` got through ungated in such a worktree. Host semantics: code.claude.com/docs/en/hooks; docs.github.com/en/copilot/reference/hooks-reference; openai/codex `hooks/src/events/pre_tool_use.rs`.                                       |
| F3  | **The Stop gate verifies wherever the shell last `cd`'d.** The repo root comes from payload `cwd`, which follows the persistent Bash cwd.                                                                                                                                                          | Headless `claude -p` probe: after `cd` into a nested worktree, the Stop payload `cwd` = the worktree, while `CLAUDE_PROJECT_DIR` = the launch root. With `claude --worktree`, `CLAUDE_PROJECT_DIR` = the worktree, so it really is the session root. In dialed.run about 150 coordinator Stop runs happened inside lane worktrees, and lane worktree state holds `stop`-rung decisions from the coordinator's session. |
| F4  | **Timeouts fail open on every host**, and runs overran their limit. Copilot's default `timeoutSec` is **30**, and our Copilot template sets none, so any commit gate longer than 30s is skipped.                                                                                                   | Copilot docs: "Default: 30"; "the tool call proceeds". Claude: "doesn't block the tool call". Codex: kills the group and marks the run Failed. In dialed.run, 14 Stop and 3 PreToolUse runs exceeded the 300s timeout and ran 6–20 minutes.                                                                                                                                                                            |
| F5  | **The Stop gate re-runs a full verify on every turn**, including idle ones (~26s median; ~750 runs in one session; 583 of 586 logged decisions were `clean`).                                                                                                                                      | `decisions.jsonl` and `stop_hook_summary` durations.                                                                                                                                                                                                                                                                                                                                                                   |
| F6  | **Fixers add suppressions despite the contract (#77).**                                                                                                                                                                                                                                            | Fixer transcripts quote the `fallow-ignore-next-line` additions made against "Do not add suppressions" prompts (a1d2…, abef…, abcc…, a0a2…).                                                                                                                                                                                                                                                                           |
| F7  | Small: `verify`/gates print `N violation(s)` that includes `warn`-severity advisories; the push gate's no-session manifest is named `commit-commit`; `.githooks/*` prints "commit blocked — resolve violations" when the CLI is simply not installed.                                              | Read in source and templates.                                                                                                                                                                                                                                                                                                                                                                                          |

## Cross-host design rules (from the host contracts)

- **The only portable block is exit 0 + a deny/block JSON.** Exit 2 means
  different things on each host (on Codex it needs a non-empty stderr). Copilot
  denies on any other non-zero pre-tool exit; Claude, Codex and VS Code let the
  tool run. So a hook mode never relies on its exit code to block. It prints the
  decision.
- **Timeouts fail open everywhere.** The only way to fail closed is to finish
  before the host's timeout. Our gate modes therefore get an internal deadline
  below the template timeout.
- **Project root:** only Claude Code exposes one (`CLAUDE_PROJECT_DIR`). Codex
  and Copilot fall back to payload `cwd` → git toplevel, as today (this is
  documented as a limitation).
- **Agent identity:** Claude only, as today. Codex and Copilot keep confining
  the whole session while a fixer manifest is active, so a stale commit-rung
  marker must expire on its own (Task 1).

## Global constraints

TDD (failing test first); no suppressions, casts, `.skip` or weakened
assertions; zero runtime deps; `unicorn/prevent-abbreviations` naming; every
task ends green on `npm run verify` in `guardrails-core` and is committed.
Templates are scaffolded into consumers, so template edits update
`templates.test`/staleness fixtures in the same task.

---

## Task 1 — Scope-lock covers commit-rung fixers (F1)

**Builds**

- `runCommitGate` writes `<manifestId>.pre-fix.json` (empty array) when it
  blocks **and** `sessionId` is defined (an agent-driven commit). It removes that
  marker when the gate passes. `.githooks/*` runs with no session and never
  activates a lock.
- `collectManifestScope(directory, sessionId, now)` treats every
  `<sessionId>.last.json` **and** `<sessionId>-<rung>.last.json` that has its own
  marker as active, and takes the union of their files.
- A commit-rung marker older than `LEASE_TTL_MS` (30 min, by mtime) is inactive.
  Without this, on Codex and Copilot an abandoned marker would confine the main
  agent until the 7-day sweep.
- `scopeCheckCommand` collects scope from every candidate root: the payload
  cwd's git root, plus the git root of each target path. It confines to the
  union, so a fixer whose cwd is the main checkout but whose files are in a
  nested worktree is locked by that worktree's manifest. The read rule allows
  any candidate root.

**Tests** (`scope.test.ts`, `commit-gate.test.ts`, `cli-core.test.ts`)

- Commit manifest + marker → an unlisted file is denied and
  `guardrails.config.json` is denied.
- A pass removes the marker; a session-less block writes no marker.
- A marker older than the TTL is inactive.
- Stop and commit manifests together give the union.
- Fixer cwd in the parent repo with a target in a nested worktree → denied by
  the worktree's manifest.

**Done:** the earlier repro now denies; full suite green.

## Task 2 — Fixers cannot add suppressions at edit time (F6, #77)

**Builds:** in `scopeCheckCommand`, for a confined caller on an edit tool,
compute the suppressions the edit **adds**:
`auditSource(file, after)` minus `auditSource(file, before)`, as a multiset by
`kind|text`.

- Claude `Edit` (`old_string`/`new_string`), `MultiEdit` (`edits[]`) and
  `Write` (`content` vs the file on disk).
- Copilot `str_replace_editor`/`edit` (`old_str`/`new_str`) and `create`
  (`file_text`).
- Codex `apply_patch`: per-file `+` lines vs `-` lines.

The edit is denied with the contract's alternative: report the violation as
unfixable, and the main agent can derive a grant with `guardrails sanction`.
Main-thread edits are untouched (Claude), and so is any session with no active
fixer.

**Tests:** each payload shape adds → denied; moving or keeping an existing
directive (present in both before and after) → allowed; a non-fixer caller →
allowed.

**Done:** green; the deny message names the kind and the reporting route.

## Task 3 — Never fail open (or deny everything) on an untrusted install (F2)

**Builds:** `outsideRepoMessage` stops being a blanket `return 1`:

- `gate --mode=pretooluse`: a git write → **deny JSON**: "guardrails-core is not
  installed in this checkout (<root>); run `npm ci` here, then retry". Anything
  else → silent allow (exit 0). This ends both the per-call noise and Copilot's
  deny-everything.
- `gate --mode=stop`: **block** with the same remedy. With `stopHookActive` it
  releases with a stderr note instead, so it never loops toward the host's
  8-block cap.
- `scope-check`: runs normally. It reads only state files, and enforcing the
  lock with an ancestor's copy beats not enforcing it.
- `autofix`, `session-start`, `session-end`: silent exit 0.
- Direct commands (`verify`, `gate --mode=commit|push|ci`, `audit`, …): unchanged
  (exit 1 + message). These are git hooks and CI, where exit 1 already blocks.

Also: a thrown error inside `gate --mode=pretooluse` (for a git write) or
`--mode=stop` becomes a deny/block carrying the error. Codex and Claude would
otherwise let a crashed gate through.

**Tests:** each command in the outside case, per dialect (claude, codex,
copilot output shapes); a thrown error in each gate mode.

**Done:** green; no hook mode returns non-zero for the outside case.

## Task 4 — Anchor session-scoped rungs on the session root (F3)

**Builds:** `CliDependencies.env` (optional; defaults to `process.env` inside
`cli-core`, the same pattern as `selfPath`). `sessionRoot(input, env)` returns
`CLAUDE_PROJECT_DIR` when the dialect is claude, the variable is set, and the
payload has no `agent_id`. Otherwise it returns the payload cwd.
`gate --mode=stop`, `session-start` and `session-end` resolve their repo root
from it. Tool-scoped modes (pretooluse, scope-check, autofix) keep the cwd/file
location, because a lane agent's commit gate must check the lane's worktree.

**Tests:** cwd in a nested worktree with `CLAUDE_PROJECT_DIR` = parent → Stop
verifies the parent. Codex and Copilot dialects ignore the variable. A subagent
payload (`agent_id`) ignores it.

**Done:** green; comment documents the Codex/Copilot limitation.

## Task 5 — Gate modes finish before the host's timeout (F4)

**Builds**

- `spawnExec` tracks live children. On POSIX it spawns them `detached` (their
  own process group); on Windows it does not.
- `terminateChildren()` signals each group (`process.kill(-pid)`, or
  `child.kill()` on Windows).
- `runWithDeadline` in `cli-core` wraps `gate --mode=stop|pretooluse`. On expiry
  it suppresses any later output, terminates children, writes the rung's
  deadline decision, and exits through an `exit` seam:
  - pretooluse git write → **deny** ("did not finish within Ns; retry when the
    machine is less loaded");
  - stop → no block, with a stderr note (unchanged semantics, but bounded and
    with no orphans).
- New config key `hookDeadlineSeconds` (default 240; it must stay below the hook
  timeout).
- The Copilot template gains `"timeoutSec": 300` on preToolUse and agentStop
  (and 120 on postToolUse), matching Claude and Codex.

**Tests:** fake exec that never resolves → the deadline fires, the right
output per dialect, terminate called, late output dropped. Config parse. The
template contains `timeoutSec`.

**Done:** green.

## Task 6 — Skip verify when nothing changed since the last clean Stop (F5)

**Builds:** `treeFingerprint(repoRoot)` copies the index to a temp file
(`git rev-parse --git-path index`), runs `git add -A` and then `git write-tree`
under `GIT_INDEX_FILE` with inherited `GIT_*` stripped, and combines the result
with the merge-base sha and the guardrails-core version. `runStopGate` runs it
when **no fix loop is open** (no snapshot, attempt 0). If it equals the stored
`last-clean-stop.json` fingerprint, the gate returns clean without running
verify, and logs a decision with `cached: true`. After every clean verified
stop it stores the fingerprint. Any git failure means no cache (it runs
verify).

**Tests:** same tree → second stop skips the verify exec; any edit, untracked
file, or base change → reruns; an open loop never uses the cache; a git failure
→ verify runs; the decision record accepts `cached`.

**Done:** green; a measured second idle Stop in this repo is under 2s.

## Task 7 — Small honesty fixes (F7)

- `verify` and the gate stderr summary print `N error(s), M warning(s)`.
- `commitManifestId(sessionId, profile)` → `<session|hook>-<rung>`.
- `.githooks/pre-commit` and `pre-push` check that the CLI exists first and say
  "guardrails-core is not installed in this checkout — run npm ci". They still
  exit 1.

**Tests:** existing count/name tests updated; template tests.

## Task 8 — Record and verify

- `plan.md` → "Roadmap: fixer-loop hardening": an entry per finding with
  evidence, marked shipped. Follow-ups not in this PR: Codex `agent_id` on
  PreToolUse (now on codex main); a push-rung wall-clock budget; a fixer verify
  runner (#93).
- `docs/live-loop-verification.md`: steps for the nested-worktree case and the
  commit-rung lock.
- `npm run build` (syncs agents), the full `npm run verify`, and
  `npm run test:coverage && npm run check:graph`. Open the PR.
- Tell the developer that hook and template changes need a fresh session to
  load.
