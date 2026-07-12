# Agent Guardrail Skill — Implementation Plan

A guardrail system for coding agents targeting **Claude Code and GitHub Copilot
as co-equal, immediate targets**, for TypeScript and Java projects (single-repo
or monorepo). Open-source tooling only. Three layers:

1. **`guardrails-core`** — an npm package (CLI: `guardrails
verify|autofix|audit|gate|state|scope-check|session-*`) holding all
   machinery. Installed as a repo devDependency; the single thing every runtime
   calls.
2. **A thin Claude Code plugin** — hooks wiring, the two fixer agents, and the
   scaffolding skill. Provides the full delegation loop on Claude Code.
3. **Per-repo policy + state** — configs, thresholds, `.claude/state/`,
   `.github/hooks/*.json`, CI workflow. Written by the scaffolder, checked in.

Built **solo-first but designed for team**: the solo→team transition is a config
flip plus a publish, not a rewrite.

The authoritative, full design lives in the conversation that produced this
repo. This file captures the load-bearing decisions and the phase plan so the
repo is self-describing.

## Normalized violation contract (the linchpin)

```ts
interface Violation {
  ruleId: string; // stable, namespaced: "ts/no-assertionless-test"
  file: string; // repo-relative
  line?: number;
  message: string;
  severity: 'error' | 'warn';
  fixable: boolean; // true → silent PostToolUse autofix class
  tool: string; // "eslint" | "tsc" | "knip" | ... | "guardrails"
  package?: string; // workspace/module id in monorepos
}
```

Recurrence memory keys on `package:ruleId` in workspace layouts.

## Control loop

Stop hook (main agent only, never agent frontmatter) → `verify` (diff-scoped) →
clean/delegate/escalate. Bounded attempt counter (no `stop_hook_active`
shortcut). Fixer is a restricted subagent (Read/Edit/Write, no Agent/Task, no
Bash) that reads the manifest into _its own_ context. Guards that hold
regardless of model tier: the **diff-auditor** (snapshot-based, rejects added
suppressions/casts/skips), **no-deletion** (fixer comments-and-flags), **hidden-
fix logging**, and **recurrence-as-signal** auto-promotion.

Model ladder: attempts `1..MAX-1` → fast fixer; final attempt → thorough fixer;
exhausted → main agent (top model, full context). Loose classes (architecture,
mutants, logic-revealing type errors, maybe-live dead code) route to the
thorough tier from attempt 1 — a **safety** mechanism, not an optimization.

## Cross-runtime map (Phase B)

Claude Code gets the full Stop-loop. On Copilot surfaces Stop is observational,
so the analog is a **PreToolUse commit/push gate** (`guardrails gate
--mode=commit`), plus a git-native `.githooks/pre-commit` (catches human commits
the agent hooks can't see). CI runs the same `verify` as the authoritative,
only-guaranteed gate.

## Build phases

- **A — guardrails-core + Claude Code loop, TS + single-repo.** ← _this branch_
- **B — Copilot channel** (all three surfaces: VS Code, CLI, cloud agent) +
  git pre-commit + CI.
- **C — TS pack complete + workspaces** (knip, dependency-cruiser, semgrep,
  stryker in CI; affected-package scoping).
- **D — Java pack + polyglot** (spotless, pmd, error-prone/nullaway, spotbugs,
  ArchUnit, pitest/descartes; Maven/Gradle report adapters).
- **E — Scaffolder + team-flip** (detection/plan/confirm/idempotency skill;
  solo→team config flip).

## Solo → team

`guardrails.config.json` carries `distribution: "solo" | "team"` and
`enforcement: "warn" | "block"`. The flip: commit `recurrence.json`, make CI a
required check, publish core + plugin, standardize thresholds — no code changes.

## Open questions surfaced in review (resolve in Phase B)

- **Fixer subagents DO port to Copilot** (corrected — an earlier draft of this
  note wrongly claimed Copilot had no subagent delegation). GitHub Copilot
  custom agents (`.agent.md`, shipped Oct 2025) support a `tools` allowlist
  (including an `agent` tool you withhold to block fan-out — the analog of
  omitting Task), per-agent `model` selection,
  `disable-model-invocation`/`user-invocable`, and **sub-agent orchestration**
  (the runtime runs the agent in an isolated context and streams lifecycle
  events to the parent; triggerable by inference, explicit instruction, or
  programmatically). Phase-B implications:
  - The two fixer agents get a second authoring format: CC frontmatter _and_ a
    `.agent.md` equivalent. The `tools` allowlist and per-agent `model` (the
    tier ladder) translate directly; scope-lock and diff-auditor are unchanged.
  - What does _not_ port is the hard forcing mechanism. CC's `Stop` hook blocks
    turn-end to compel the loop; Copilot `Stop` is observational (only
    `preToolUse` blocks), so the Copilot fixer loop is triggered by the
    commit-gate deny + `AGENTS.md`/`copilot-instructions` steering + explicit or
    programmatic delegation — a softer loop, not a within-turn force.
  - The per-fixer `model` (tier) is now a real cross-runtime knob; the fixer
    _names_ are already config-driven via `guardrails.config.json`.
- **State location on non-Claude surfaces.** State currently lives under
  `.claude/state/guardrails/`. For the Copilot channel a runtime-neutral path
  (e.g. `.guardrails/state/`) may be cleaner than borrowing Claude's dir.
  `stateDirectory()` is the single chokepoint, so this is a one-function change +
  a config knob — deferred to Phase B so the CC plugin's hardcoded paths and the
  current tests don't churn now.

## Roadmap: boundary type-safety as a first-class concern

Surfaced by the Phase-A review (unchecked `as` casts on loaded state). The root
is systemic, not three one-off bugs: the scaffold ESLint config disables
`@typescript-eslint/no-unsafe-*` and bets on "manual runtime narrowing at
boundaries", but manual narrowing is easy to do incompletely — so the static
net is off exactly where untrusted data enters (disk JSON: state, manifests,
config; and external-tool output). Two tracks:

- **Internal (guardrails-core, dogfooding).** Make boundary validation a uniform
  convention, not per-site heroics. Either a small codec/guard module so
  deserialization returns _validated_ types instead of `as`-asserted ones
  (parse-don't-validate), and/or **re-enable `no-unsafe-*` scoped to boundary
  modules** and satisfy them with real guards. Keep core dependency-light — hand-
  rolled guards or a tiny validator, not `zod` in core (reserve schema libraries
  for scaffolded target repos). The good pattern already exists (`isViolation`,
  `isResultArray`); the work is applying it uniformly.
- **Product (a guardrail rule class).** "Unvalidated deserialization / structural
  `as` cast at a trust boundary" is a canonical green-but-wrong: an agent asserts
  a shape to make `tsc` pass without proving it. The diff-auditor already rejects
  `as any` / `as unknown as`; extend it (semgrep or a custom ESLint rule) to
  structural casts and `JSON.parse(...) as T` at boundaries, and route it as a
  **loose class** (§2.3) above the bottom fixer tier. The fixer already forbids
  adding new casts, so recurrence memory surfaces repeat offenders automatically.

## Phase A status

Built and tested (Vitest, strict TS → ESM): the `Violation` contract, session
plus cross-session recurrence memory with persistence, the diff-auditor, the
verify orchestrator with eslint/tsc adapters and diff-scoping, the gate decision
engine with snapshot-based composition, the full CLI, and the thin Claude Code
plugin with two scope-locked fixer agents. See `README.md` and
`docs/live-loop-verification.md`.
