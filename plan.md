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

Claude Code gets the full Stop-loop. **Correction (Phase B):** an earlier draft
of this section claimed Copilot `Stop` is observational — it isn't. Copilot's
`agentStop` (= Claude `Stop`) **can block turn-end and force another turn**
using the returned `reason` as the next prompt, so the within-turn forcing loop
_does_ port. The Copilot analog is **richest-per-surface**, not a single
downgraded mechanism: `agentStop`-block where the surface supports it, the
`preToolUse` commit/push gate (`guardrails gate --mode=pretooluse`) as the
**universal deny** — and the **only reliable gate on the cloud agent**, whose
restricted surface makes it the conservative floor — with a git-native
`.githooks/pre-commit` (catches human commits the agent hooks can't see) and CI
`verify` beneath every surface as the authoritative, only-guaranteed gate. See
`docs/superpowers/specs/2026-07-16-phase-b-copilot-channel-design.md` for the
full enforcement matrix and per-surface research grounding.

## Build phases

- **A — guardrails-core + Claude Code loop, TS + single-repo.** Shipped.
- **B — Copilot channel** (all three surfaces: VS Code, CLI, cloud agent) +
  git pre-commit + CI. Shipped (headless); see "Phase B status" below. ← _this
  branch_
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

## Open questions surfaced in review — resolved in Phase B

The Phase-A draft of this section raised the questions below; each is now a
settled fact, recorded here rather than left open.

- **Fixer subagents DO port to Copilot** (corrected — an earlier draft of this
  note wrongly claimed Copilot had no subagent delegation). GitHub Copilot
  custom agents (`.agent.md`, shipped Oct 2025) support a `tools` allowlist
  (including an `agent` tool you withhold to block fan-out — the analog of
  omitting Task), per-agent `model` selection,
  `disable-model-invocation`/`user-invocable`, and **sub-agent orchestration**
  (the runtime runs the agent in an isolated context and streams lifecycle
  events to the parent; triggerable by inference, explicit instruction, or
  programmatically). And the hard forcing mechanism ports too — see the §7
  correction above; Copilot `agentStop` blocks turn-end just like Claude
  `Stop`. Phase-B implications:
  - The two fixer agents get a second authoring format: CC frontmatter _and_ a
    `.agent.md` equivalent, generated by `scripts/sync-agents.mjs` from the
    single source `guardrails-plugin/agents/`. The `tools` allowlist and
    per-agent `model` (the tier ladder) translate directly.
  - **Scope-lock is enforced repo-level on CLI/cloud, not via `.agent.md`
    frontmatter.** Per-agent `hooks` frontmatter is **VS-Code-Preview only,
    unconfirmed on CLI/cloud**, so it can't be the cross-surface mechanism. A
    repo-level `preToolUse` self-filter (`guardrails scope-check`, keyed off
    the active manifest in state) denies out-of-manifest fixer edits on every
    surface instead. VS Code additionally carries the frontmatter form via its
    `.claude/` reuse.
  - The per-fixer `model` (tier) is now a real cross-runtime knob; the fixer
    _names_ are already config-driven via `guardrails.config.json`.
  - **Copilot fixer tier-ladder remains pending model-id confirmation — a
    config-only flip, no code change.** `scripts/sync-agents.mjs` emits
    `.github/agents/*.agent.md` with the `tools` allowlist and `agents: []`
    wired, and will write a `model:` line from
    `RepoConfig.copilotFastModel`/`copilotThoroughModel` whenever those knobs
    are set — but GitHub's custom-agents docs still don't enumerate valid
    `model:` identifier strings (only "inherits the default model" if unset),
    so the knobs stay unset and the fixers load on Copilot's default model.
    Once the exact ids are confirmable, set them in `guardrails.config.json`
    and rebuild; no script or type change needed.
- **State location on non-Claude surfaces — resolved: `.guardrails/state/`.**
  State converged on this runtime-neutral path for **both** Claude Code and
  Copilot (off the old `.claude/state/guardrails/`). `stateDirectory()` was
  the single chokepoint, so this was a one-function change plus updates to
  `.gitignore`, the CC dogfooding wiring, and `CLAUDE.md`/plugin references.
  No data migration was needed — state is ephemeral (session tally +
  manifests, 7-day TTL).
- **Copilot payload binding is local (no supported import path) — confirmed,
  and stays local.** `@github/copilot-sdk`'s `dist/types.d.ts` declares
  `BaseHookInput` (`sessionId`, `workingDirectory`) and
  `PreToolUseHookInput`/`PostToolUseHookInput` (`toolName`, `toolArgs:
unknown`), but the package's `exports` map exposes only `.` (→
  `dist/index.d.ts`, which does not re-export these types) and `./extension`
  — there is no supported subpath to import them from. `hook-io.ts`'s
  `CopilotHookPayload` is therefore a hand-declared local interface, not an
  SDK `Pick`, and `@github/copilot-sdk` itself is **not** a project
  dependency (it was imported by nothing and only pulled in native FFI deps
  for zero drift-safety). Re-bind `CopilotHookPayload` to the SDK types if/when
  a future release exports them via a supported path — until then, an SDK
  rename of `workingDirectory`/`toolName`/`sessionId` won't be caught by the
  type checker, and this binding is the one spot in the Copilot channel where
  a build-breaking drift-guard is currently unavailable.
- **Hooks Preview status and enterprise policy — resolved.** VS Code's hooks
  capability is **Preview** (format may still change there); CLI and cloud
  ingest the same `.github/hooks/*.json` mechanism and are treated as
  **effectively shipped**, not Preview. No enterprise policy specifically
  gates `.github/hooks` or custom agents — org admins can only disable the
  whole surface (CLI or cloud agent) outright, which is a deployment
  consideration for the scaffolder (Phase E), not a Phase-B blocker.
- **Native dialect and matcher behavior — resolved.** The native, non-Claude
  dialect is **camelCase** in `.github/hooks/guardrails.json`
  (`preToolUse`/`postToolUse`/`agentStop`, envelope `{ version: 1,
disableAllHooks, hooks: {} }`). Matchers exist natively on CLI/cloud but
  **VS Code parses and ignores them**, so every hook self-filters on
  `toolName`/command text rather than relying on matcher config — this makes
  the same hook definitions behave identically whether or not the host
  surface honors matchers.

**Carry-in #2 (CC scope-lock frontmatter firing) — pending live-loop, not yet
confirmed.** The headless suite proves the Copilot channel's machinery (dual
payload parsing, `gate --mode=pretooluse`, the merge-base baseline, the
`agentStop` output shape, `stateDirectory()`), but the scope-lock's actual
firing on a live host can only be observed interactively: `docs/copilot-live-
loop-verification.md` (§2) drives a real VS Code Copilot agent-mode session,
forces an out-of-repo read, and records PASS/FAIL directly in that document
(with the result to be reflected here once run). Phase B ships with this step
**not yet executed** — do not read this as a passing result.

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

## Roadmap: fixer-loop hardening (from the dogfooding live proof)

The first live run (assertionless test → escalation → correct fix) validated the
escalation ladder but surfaced improvements. Two are implemented on the
dogfooding branch (built-in loose-rule routing so test-integrity rules go to the
thorough tier from attempt 1; a `Read`-matcher scope-check denying the fixer
reads outside `repoRoot`). One remains:

- **Diff-auditor was mention-blind, not suppression-blind — resolved in Phase
  B.** Dogfooding the auditor against its own diff (see `guardrails-
core/src/audit.ts`) surfaced that it was a context-free text scan: it flagged
  suppression-token _mentions_ — prose describing a token, string literals
  (e.g. a test fixture asserting on diff text), and even its own pattern
  source in `audit.ts` (`pattern: /@Disabled\b/` self-matched as a `code`
  finding on every edit to the file) — indistinguishably from real
  suppressions. Phase B made it **mention-aware**: a source-file extension
  gate (`AUDITABLE_EXTENSIONS`, so non-source files are never scanned);
  `directive`-class signatures (`eslint-disable`, `@ts-*`) are flagged only
  when they lead a comment, not when they appear as prose or inside a string/
  regex; `code`-class signatures (casts, Java annotations, test-skip calls)
  are matched only against the lexed **code portion** of a line, with a
  single-line lexer that excludes string, comment, regex, and (recursively,
  one level deep) template-interpolation spans. **Known limitations,
  documented in `audit.ts`:** the lexer is single-line only, so a suppression
  hidden inside the body of a `/* ... */` block or doc comment that spans
  multiple diff lines is not matched (an accepted under-match, never an
  over-match); and a template literal nested _inside_ another template's
  `${...}` interpolation is skipped as an opaque string span rather than
  recursively lexed. Also noted while auditing the commit path: **both
  `gate --mode=commit` and `gate --mode=pretooluse` currently hard-block
  unconditionally** on any finding — they do not yet consult
  `RepoConfig.enforcement` (`"warn"` vs `"block"`). Honoring `enforcement` on
  the commit/pretooluse gates is deferred; it's reserved for the solo→team
  flip (Phase E), where `enforcement: "block"` becomes the team default.

- **Auditor soundness: text lexer → AST (decided, roadmapped).** The auditor is
  a hand-rolled single-line lexer + regex signatures operating on _diff
  fragments_, not a sound parser. This has a permanent evasion ceiling for
  **false negatives**: any construct the line-lexer can't see (multi-line spans,
  above; unicode-escaped tokens; deliberately obfuscated formatting) can slip a
  real suppression past it. It is adequate _today_ because the threat is a
  weak-tier fixer adding **idiomatic** suppressions (which it catches) and it is
  one layer in defense-in-depth (scope-locked low-privilege fixer + `verify`/tsc
  - pre-push tests + CI + human review) — not the sole guarantee. It is also
    JS-centric: the regex-literal lexing is unsound for Java (no regex literals;
    `return a/b` could misparse), a latent fragility until the Phase-D Java pack.
    **The sound path (chosen for a future phase, not Phase B):** replace the text
    scan for TypeScript with a **TypeScript-compiler-API auditor** — reconstruct
    the post-fix file, walk the AST for suppression comment ranges, cast nodes
    (`AsExpression`/type-assertion), and `.skip`/`.only` calls, then intersect
    with the diff's added-line ranges. That structurally removes the string /
    comment / regex / template / multi-line false-positive _and_ false-negative
    classes for TS. `typescript` is resolved from the target repo (like the
    `eslint`/`tsc` bins today), so it adds no new dependency for TS projects; Java
    gets its own parser with the Phase-D pack. The text auditor stays as the fast,
    dependency-light, cross-language first pass. (Decision: Phase-B review, 2026-07;
    the text auditor ships as the Phase-B floor, backstopped.)

- **Repo-hygiene: `main` is stale in this worktree.** This worktree's `main`
  ref still sits at the initial commit, so the commit gate's merge-base diff
  (added by Phase B's baseline fix, above) spans the **entire repo history**
  rather than just this phase's changes — every previously-landed suppression
  is (correctly, but wastefully) re-diffed and re-audited on every commit.
  Advancing `main` to the true integration base once this branch merges would
  both narrow the gate's diff scope and speed up `verify`; no code change,
  just a repo-hygiene follow-up.

- **Per-cycle diff-auditing (oscillation / test-weakening).** The diff-auditor
  is anchored to the _original_ pre-fix snapshot, so a fixer that adds an
  assertion and a later fixer that removes it nets back to baseline on a _new_
  file and slips through — the momentary weakening isn't flagged (it was caught
  only because re-verify + escalation converged). Fix: audit each fixer's edit
  against the _immediately prior_ fixer state (snapshot per cycle, not once), and
  extend the auditor's signatures to flag _removed_ assertions (`-` lines
  containing `expect(`/`assert`), not just _added_ suppressions. Needs its own
  small design (per-cycle snapshot lifecycle + false-positive guard for
  legitimate refactors).

- **Fixer edit-scope: cross-file fixes** (raised in PR #4 review). The
  scope-lock confines the fixer to the files named in the manifest, but the
  _optimal_ fix sometimes lives elsewhere — a type error surfaced in `A.ts`
  whose real cause is a wrong type in `B.ts`. Today that fix is **denied**, the
  fixer can't resolve it, attempts exhaust, and it **escalates to the main
  agent** (terminal tier, no scope-lock, full latitude) — which is the intended
  safety fallback, but it burns attempts first. Options to consider: let the
  manifest carry a broader `editScope` (e.g. the flagged file's local imports),
  or let the fixer _request_ an out-of-manifest edit that the gate approves once.
  Monorepo sibling packages are already in-scope when `repoRoot` is the workspace
  root, so this is about genuinely cross-file (not cross-package) fixes.

- **Configurable read-scope** (raised in PR #4 review). The `Read` scope-check
  denies all out-of-repo reads. A repo might legitimately need the fixer to read
  an external shared config or tool file. Deferred (YAGNI) — no concrete use case
  yet, and the safe default is deny; monorepo siblings are already in-repo when
  `repoRoot` is the workspace root. When a real case appears, add a
  `fixerReadAllowlist: string[]` to `guardrails.config.json` (extra roots the
  fixer may read), mirroring how `looseRules` extends the built-in defaults.

## Phase A status

Built and tested (Vitest, strict TS → ESM): the `Violation` contract, session
plus cross-session recurrence memory with persistence, the diff-auditor, the
verify orchestrator with eslint/tsc adapters and diff-scoping, the gate decision
engine with snapshot-based composition, the full CLI, and the thin Claude Code
plugin with two scope-locked fixer agents. See `README.md` and
`docs/live-loop-verification.md`.

## Phase B status

Headless machinery shipped and tested; the VS Code/CLI live-loop is documented
but not yet run (see carry-in #2 above). What shipped:

- **Dual-dialect hook I/O** — `parseHookInput` accepts both Claude-format
  (snake_case) and Copilot-native (camelCase) payloads and normalizes to one
  internal shape; `formatStopHookOutput` emits both Claude `Stop` and Copilot
  `agentStop` decision shapes.
- **`gate --mode=pretooluse`** — the self-filtering Copilot commit/push gate
  (fires only on `git commit`/`git push` shell calls; denies on a dirty tree,
  allows otherwise), the universal deny and the only reliable gate on cloud.
- **Merge-base commit baseline** — `gate --mode=commit` (and `--mode=pretooluse`)
  now diff-audits against the branch's merge-base with `main` instead of no
  baseline, so only newly-introduced suppressions/casts flag, not everything
  already on the branch.
- **Mention-aware diff-auditor** — see the "Roadmap: fixer-loop hardening"
  finding above.
- **`.github/hooks/guardrails.json`** (native camelCase config for CLI + cloud:
  `postToolUse` autofix, `agentStop` block-to-force, `preToolUse` commit/push
  gate, `preToolUse` repo-level fixer scope-lock) and generated, **committed**
  `.github/agents/guardrail-fixer.agent.md` / `guardrail-fixer-thorough.agent.md`
  (single source of truth remains `guardrails-plugin/agents/`, emitted by
  `scripts/sync-agents.mjs`; CI drift-guards the committed output).
- **git pre-commit + CI `verify` floors** beneath every surface — this repo's
  Husky `pre-commit` now runs `guardrails gate --mode=commit`, and CI runs the
  same `verify` gate on the PR diff, both authoritative regardless of which
  agent surface produced the change.
- **`.guardrails/state/`** — state converged onto this runtime-neutral
  directory for both Claude Code and Copilot (see the "State location"
  resolution above).
