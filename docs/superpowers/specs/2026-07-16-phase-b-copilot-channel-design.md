# Phase B — GitHub Copilot Channel — Design

**Date:** 2026-07-16
**Status:** approved (brainstorming) → ready for implementation plan
**Milestone:** Phase B — extend the guardrail loop to GitHub Copilot across all three surfaces (VS Code agent mode, Copilot CLI, cloud coding agent), add the git-native floor and the CI gate.

## Goal

Give the guardrail loop a **GitHub Copilot channel** that is co-equal with the
Claude Code channel: the same `guardrails-core` CLI, the same fixer subagents,
the same normalized `Violation` contract — driven by Copilot's native hook and
custom-agent mechanisms instead of Claude Code's. Prove it live on VS Code agent
mode first (the day-to-day dev surface), wire CLI + cloud on the same shared
config, and lay the two tool-agnostic floors (git pre-commit + CI) beneath every
surface.

This is a **breadth-to-a-second-runtime** milestone. It introduces no new check
_classes_ (knip/semgrep/etc. remain Phase C) — the novel value is proving the
loop mechanics port to a runtime with a different, but strikingly similar, hook
model.

### Non-goals (deferred)

- New check classes — knip / dependency-cruiser / semgrep / dependency-drift /
  ArchUnit-equivalents (Phase C).
- Monorepo / affected-package scoping (Phase C); Java pack (Phase D).
- The scaffolder that _writes_ this Copilot config into a target repo (Phase E).
  Phase B authors the artifacts by hand in this repo; the scaffolder templatizes
  them later.
- Cloud-agent **live** proof — wired and documented, but its slow
  push-to-default-branch feedback loop makes live iteration impractical this
  phase; CLI is the native-dialect live proof.

## Research grounding (mid-2026 GitHub/VS Code docs)

Settled before design; full sourced report captured in the brainstorming
conversation. The load-bearing facts:

- **Copilot ships a hooks mechanism directly analogous to Claude Code's**, and it
  natively ingests **Claude-format (PascalCase) events** _and_ camelCase
  (`preToolUse`). Config lives in `.github/hooks/*.json`, envelope
  `{ version: 1, disableAllHooks, hooks: {} }`. stdin-JSON-in / stdout-decision-
  JSON-out, same as CC.
- **`preToolUse` can deny** a tool call (and **fails closed** on a crash);
  **`agentStop` (= Claude `Stop`) can block turn-end and force another turn**
  using the returned `reason` as the next prompt. → **Correction to `plan.md`
  §7**, which assumed Copilot `Stop` is observational. The within-turn forcing
  loop _does_ port.
- **Matchers exist** natively on CLI/cloud, but **VS Code parses and ignores
  them** → hooks must self-filter on `toolName` to be universal.
- **Surfaces differ sharply.** Cloud agent is most restricted: only
  `.github/hooks/*.json` **on the default branch**, `bash`-only command hooks,
  tools pre-approved → **`preToolUse` is the only reliable gate** there. CLI is
  richest. VS Code hooks are **Preview**, and VS Code **natively reads Claude-
  format config** (`.claude/settings.json`, per-agent frontmatter hooks).
- **Custom agents (`.github/agents/*.agent.md`) are GA** (Oct 2025) on CLI +
  cloud. Fan-out is blocked by withholding the `agent`/`Task` tool **and/or**
  `agents: []`. **Per-agent `hooks` frontmatter is VS-Code-Preview only,
  unconfirmed on CLI/cloud** → scope-lock can't depend on it cross-surface.
- **Enterprise policy:** no dedicated policy toggles `.github/hooks` or custom
  agents; admins can only disable the whole surface (CLI / cloud-agent) org-wide.
  Nothing hook-specific stands in the way of shipping the config.
- **Type-only dep:** `@github/copilot-sdk` (npm, MIT, GA June 2026) is
  JSON-Schema-generated with typed hook handlers, but its coverage of the
  _file-hook wire format_ is **unconfirmed** → verify exports during impl.

## Approach: richest-per-surface, two dialects, floors beneath

Every surface gets the strongest mechanism it reliably supports; weaker, tool-
agnostic layers sit beneath as backstops no surface can skip. We deliberately run
**two hook dialects**, each in its surface's idiom:

- **VS Code** rides the **existing Claude-format `.claude/` wiring** it reads
  natively (already present from the dogfooding pivot). Validating VS Code is
  therefore a _second-runtime proof_ of the Claude-format loop, not new config —
  and it doubles as the test of the fixer scope-lock frontmatter (carry-in #2).
- **CLI + cloud** use the new **camelCase-native `.github/hooks/guardrails.json`**
  and `@github/copilot-sdk` types.

Because VS Code reads both `.claude/` and `.github/hooks/`, pointing it at the
native dialect too would **double-fire** (double autofix/gate/attempt-count). We
avoid that by scoping the native dialect to CLI/cloud and leaving VS Code on
`.claude/`. A Copilot-only consumer repo (no `.claude/`) gets its VS Code
coverage once the scaffolder templatizes the native dialect (Phase E); this phase
proves VS Code via `.claude/` reuse.

### The enforcement matrix

| Layer                 | VS Code (reuses `.claude/`)            | Copilot CLI (`.github/hooks/`)                         | Cloud agent (`.github/hooks/`, default branch only) |
| --------------------- | -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| **Per-edit autofix**  | `PostToolUse` (Claude-fmt) → `autofix` | `postToolUse`, self-filter edit tools → `autofix`      | same                                                |
| **Within-turn force** | `Stop` blocks → delegate to fixer      | `agentStop` block → delegate                           | `agentStop` block (if it fires) → delegate          |
| **Commit/push gate**  | _(optional add to `.claude/`)_         | `preToolUse` matcher `bash`, deny on dirty             | **`preToolUse` — the only reliable gate here**      |
| **Fixer scope-lock**  | per-agent frontmatter hook (Preview)   | repo-level `preToolUse` self-filter on active manifest | same repo-level self-filter                         |
| **git-native floor**  | `.githooks/pre-commit` (any committer) | same                                                   | cloud commits shell out → fires                     |
| **CI floor**          | `guardrails verify` job                | same                                                   | same                                                |

Two consequences:

- **Scope-lock is enforced repo-level, not via `.agent.md` frontmatter.**
  `scope-check` already keys off the active manifest in state, so a repo-level
  `preToolUse` self-filters the fixer's edit-scope without frontmatter hooks
  (which are unconfirmed on CLI/cloud). VS Code keeps the frontmatter form.
- **Cloud is the conservative floor.** `preToolUse` is its only reliable gate, so
  the commit/push gate is _primary_ there, not optional.

## guardrails-core changes (all TDD-first)

1. **Dual payload parsing.** Extend `parseHookInput` to accept Copilot camelCase
   payloads (`toolName`, `toolArgs`, `sessionId`, `cwd`) alongside the Claude-
   format snake_case it handles today. Normalize to one internal shape; a
   discriminant picks the parser. Hook I/O types from the `@github/copilot-sdk`
   type-only devDep — **verified against the package's actual exports first**;
   fall back to reusing the `@anthropic-ai/claude-agent-sdk` types (Copilot
   ingests that dialect anyway) if the file-hook wire types don't line up.

2. **Hook-style commit/push gate — `gate --mode=pretooluse`.** Reads stdin, self-
   filters (fires only when `toolName` is a shell tool whose command matches
   `git commit` / `git push`), runs `verify` + staged-diff audit, and emits
   `{ permissionDecision: "deny", permissionDecisionReason }` when the tree is
   dirty, else allows (empty output). This is the Copilot commit gate; distinct
   from the existing exit-code `gate --mode=commit` (used by CI / git hook).

3. **Commit-gate baseline fix.** `gate --mode=commit` today audits the staged diff
   with _no baseline_, so a suppression already on the branch flags on **every**
   commit (the Phase-A stub called this out). Add a **merge-base baseline** so
   only **newly introduced** suppressions/casts flag. Required to make both the
   `preToolUse` gate and `.githooks/pre-commit` usable.

4. **Copilot `agentStop` output shape.** `formatStopHookOutput` must emit
   Copilot's `agentStop` decision (`{ decision: "block", reason }`) when driven by
   the native channel, alongside the Claude `Stop` shape it produces today.

5. **`stateDirectory()` → `.guardrails/state/`** for **both** runtimes (the
   chosen convergence). No data migration — state is ephemeral (session tally +
   manifests, 7-day TTL); the old `.claude/state/` dir is abandoned. Update the
   function, its tests, `.gitignore`, and the CC dogfooding wiring +
   `CLAUDE.md`/plugin references.

## Config artifacts authored this phase

1. **`.github/hooks/guardrails.json`** (camelCase native; CLI + cloud):
   - `postToolUse` (self-filter edit/create/str_replace tools) → `guardrails autofix`
   - `agentStop` → `guardrails gate --mode=stop` (block-to-force)
   - `preToolUse` (matcher `bash`, self-filter `git commit`/`git push`) →
     `guardrails gate --mode=pretooluse` (deny on dirty)
   - `preToolUse` (repo-level fixer scope-lock) → `guardrails scope-check`
   - Envelope `{ version: 1, hooks: {…} }`; self-filtering everywhere so it is
     identical across surfaces.

2. **`.github/agents/guardrail-fixer.agent.md` + `guardrail-fixer-thorough.agent.md`**
   — the fixer subagents in Copilot format. Frontmatter maps directly: `tools`
   allowlist, `model` (the tier ladder), **`agents: []` and withhold the `agent`
   tool** (double-lock against fan-out), `description`. **Single source of truth
   stays `guardrails-plugin/agents/`** — extend `scripts/sync-agents.mjs` to also
   emit the `.agent.md` variant (translating frontmatter), so the CC and Copilot
   fixers cannot drift. `.github/agents/` is generated + gitignored like
   `.claude/agents/`. Scope-lock is enforced repo-level (§config item above), not
   via `.agent.md` frontmatter hooks.

3. **`.githooks/pre-commit`** — the universal, tool-agnostic floor: runs
   `guardrails gate --mode=commit`, activated by `core.hooksPath`. This is the
   **scaffolded artifact for consumer repos**. This repo already uses Husky, so we
   integrate the same `guardrails gate --mode=commit` call into `.husky/pre-commit`
   rather than contend for `core.hooksPath`; the standalone `.githooks/pre-commit`
   ships as the consumer-repo template and is documented as such.

4. **CI: `guardrails verify` gate** — a job/step in `.github/workflows/ci.yml`,
   the authoritative, only-guaranteed gate (§7). Runs the same `verify` on the PR
   diff.

## Data flow (Copilot loop, once live)

```
agent edits a file
  └─ postToolUse (self-filter edit tools) → guardrails autofix  (silent eslint --fix)
agent runs `git commit`/`git push`
  └─ preToolUse (bash, self-filter) → guardrails gate --mode=pretooluse
       verify + staged-diff audit (merge-base baseline)
       clean? → allow ; dirty? → deny with terse reason
agent finishes turn
  └─ agentStop → guardrails gate --mode=stop
       verify → clean? end ; else block with terse pointer (force another turn)
  └─ agent invokes guardrail-fixer (agents:[], no `agent` tool → no fan-out)
       fixer edits; repo-level preToolUse scope-check denies out-of-manifest edits
  └─ agent tries to stop again → gate re-verifies (+ diff-audits the fixer)
beneath all of it: .githooks/pre-commit (any committer) and CI verify (authoritative)
```

## Validation

The first surface (VS Code) is interactive-only, so validation is layered:

**Headless (CI-gating, the bulk — all TDD-first in `guardrails-core`):**

- Dual payload parsing fed synthetic **Copilot** _and_ **Claude** payloads →
  identical normalized shape.
- `gate --mode=pretooluse` emits deny JSON on a dirty tree, allow (empty) on
  clean, and no-ops on non-git tool calls.
- Merge-base baseline: a suppression **pre-existing** on the branch → allowed; a
  **newly-added** suppression → denied.
- Copilot `agentStop` output shape.
- `stateDirectory()` relocation.
- Schema/parse check that `.github/hooks/guardrails.json` and both `.agent.md`
  files are valid.

**VS Code live-loop (manual — the first-surface proof):** a
`docs/copilot-live-loop-verification.md` mirroring the CC one, driven in a VS Code
Copilot agent-mode session against the existing `.claude/` wiring: assertionless
test → Stop blocks with pointer → fixer spawns and fixes → re-verify clean; then
force an **out-of-repo read** to confirm the scope-lock frontmatter fires — the
denied read is the signal. **This closes carry-in #2** (record the result in
`plan.md`).

**CLI live-loop (native-dialect proof, when reached):** the same script driven
through Copilot CLI against `.github/hooks/guardrails.json` — the headless-
drivable proof of the native channel. Cloud is documented but its live proof is
deferred.

## Safety (circular-brick mitigation, unchanged in spirit)

- **git pre-commit (Husky/`.githooks`) and CI `verify` remain hard floors** — a
  bug in the Copilot loop cannot land broken code.
- **Kill-switch:** the native dialect is a single checked-in file
  (`.github/hooks/guardrails.json`); `disableAllHooks: true` in its envelope, or
  deleting it, instantly reverts. `.claude/` retains its existing comment-out
  kill-switch for VS Code.
- **Preview insulation:** VS Code hooks are Preview, but VS Code rides `.claude/`
  (the mature path), not the native dialect — so Preview churn doesn't touch the
  new artifacts.

## Risks / open items (carried into the plan)

- **`@github/copilot-sdk` file-hook type coverage unconfirmed** → verify exports
  first thing in impl; fall back to reusing the Claude types.
- **VS Code hooks are Preview** (format may change) — insulated (see Safety).
- **Carry-in #2** (CC scope-lock frontmatter firing) remains _unconfirmed_ until
  the VS Code live-loop runs — flagged, not assumed. The denied out-of-repo read
  is the confirming signal; record in `plan.md`.
- **`agentStop` on cloud** — docs say it fires, but cloud is the least-tested
  surface; the `preToolUse` commit gate is the guaranteed floor there regardless.
- **No enterprise policy blocks hooks**, but the whole surface (CLI/cloud) can be
  disabled org-wide — a deployment consideration for the scaffolder (Phase E), not
  a Phase-B blocker.

## `plan.md` updates this phase implies

- **Correct §7**: Copilot `Stop`/`agentStop` **can** block turn-end (not
  observational); the analog is richest-per-surface (Stop-force where supported +
  `preToolUse` commit/push gate universal + git + CI).
- Record the settled Phase-B unknowns (Preview status, no hook-specific enterprise
  policy, dialect quirks, VS-Code-first).
- Close carry-in #2 after the live-loop.
