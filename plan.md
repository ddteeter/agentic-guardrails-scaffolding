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
  guidance?: string; // repo-relative doc for this class (Phase C piece 4)
}
```

Recurrence memory keys on `package:ruleId` in workspace layouts.

## Control loop

Stop hook (main agent only, never agent frontmatter) → `verify` (diff-scoped) →
clean/delegate/escalate/release. `stop_hook_active` distinguishes retries from
new turns: retries spend the bounded attempt budget but do not inflate
recurrence, the exhausted loop gives the main agent one full dump, and its next
still-failing retry is released instead of restarting forever. Fixer is a
restricted subagent (Read/Edit/Write, no Agent/Task, no Bash) that reads the
manifest into _its own_ context. Guards that hold
regardless of model tier: the **diff-auditor** (snapshot-based, rejects added
suppressions/casts/skips), **no-deletion** (fixer comments-and-flags), **hidden-
fix logging**, and **recurrence-as-signal** auto-promotion.

Model ladder: attempts `1..MAX-1` → fast fixer; final attempt → thorough fixer;
exhausted → main agent (top model, full context) → terminal release if still
unfixable. Loose classes (architecture,
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
  stryker in CI; affected-package scoping). Shipped. Analyzers: knip (piece 1),
  dependency-cruiser (piece 2), semgrep retired as a no-go (piece 3), stryker
  (piece 4), workspaces / affected-package attribution (piece 6).
- **D — Java pack + polyglot** (spotless, pmd, error-prone/nullaway, spotbugs,
  ArchUnit, pitest/descartes; Maven/Gradle report adapters).
- **E — Adoption: analyzer opt-in, `guardrails init`, team-flip.** Seven pieces:
  (1) analyzer opt-in — shipped; (2) `enforcement` honored by the commit and
  preToolUse gates — shipped; (3) packaging + release — shipped; (4)
  `guardrails init` — shipped, see "Phase E status" below; (5) the scaffolding
  skill; (6) CI template + adoption docs + team-flip verification; (7) cut the
  release, adopt in a real project, record findings.

## Solo → team

`guardrails.config.json` carries `distribution: "solo" | "team"` and
`enforcement: "warn" | "block"`. This section has asserted since Phase A that
the flip is "config plus a publish, not a rewrite." Phase E piece 6 **tested**
that claim (spec §8.3) instead of restating it — recorded here with the
evidence, not just the verdict.

**The prediction on record was half right.** It held that committing
`recurrence.json` was the one non-config-only step, but for a different reason
than predicted: `sweepStale` (`guardrails-core/src/state-store.ts`) already
special-cases `name === 'recurrence.json'` — it is **not** on the 7-day TTL
sweep and never was; `guardrails-core/test/state-store.test.ts`'s "spares
recurrence.json from the TTL sweep, however stale" pins this. What broke the
claim instead was `.gitignore`: `mergeGitignore` wrote a blanket
`.guardrails/state/` directory-ignore with no carve-out, so committing the
ledger required `git add -f` on every change (a tracked file inside an
ignored directory keeps needing `-f` for each new hunk unless something
excludes it explicitly) — that is a real, if small, procedural step a "config
plus a publish" description hides.

**The fix, applied:** `GITIGNORE_BLOCK` (`guardrails-core/src/scaffold/merge.ts`,
shipped into every consumer repo via `mergeGitignore`) and this repo's own
root `.gitignore` now read `.guardrails/state/*` plus
`!.guardrails/state/recurrence.json`, instead of a bare `.guardrails/state/`.
git never re-includes a path whose parent directory is itself excluded, so the
fix wildcards the directory's _contents_ rather than excluding the directory,
which is what lets the negation take effect. This is proven against real git
behavior, not just against the string the merger produces, by
`guardrails-core/test/scaffold/gitignore-recurrence.test.ts` — it spawns a
throwaway repo and confirms `recurrence.json` is not reported by
`git check-ignore`, that a sibling session file in the same directory still
is, and that `git add .guardrails/state/recurrence.json` succeeds with no
`-f`. Everything else in `.guardrails/state/` (session tallies, violation
manifests) stays ignored, matching `sweepStale`'s own exemption.

**What is genuinely config-only, verified against the two commands that
actually consult it (`gateCommitCommand`, `gatePreToolUseCommand` in
`cli-core.ts`):** setting `enforcement: "block"` in `guardrails.config.json`
is the one flag that changes gate behavior — it flips `gate --mode=commit`
(run by `.githooks/pre-commit` and by the CI template's
`guardrails gate --mode=commit` step) and `gate --mode=pretooluse` from a
zero exit with a "not blocking" note to an actual deny/non-zero. Marking that
CI job "required" in GitHub branch protection is a GitHub-side setting, not a
code change, and only does something once `enforcement` is `"block"` — under
`"warn"` the job always exits 0 regardless of findings, so "required" and
"warn" together is a check that can never fail. `distribution` itself is
**not consulted by any code path** — grep confirms it is read only by
`init`'s flag parser and `guardrailsConfigSeed` (the value it seeds into a
fresh config); no gate, verify, or CI logic branches on it. It is a
documentation field the team declares for humans, not a switch.

**The verified procedure**, in order: (1) get `guardrails verify` clean
(the clean-baseline prerequisite `docs/adoption.md` states applies here
too — a team flip onto a dirty baseline just gives every teammate the same
false-positive gate a solo dev would have hit); (2) set `enforcement: "block"`
in `guardrails.config.json`; (3) `git add .guardrails/state/recurrence.json`
— no `-f`: the wildcard-plus-negation `.gitignore` entry means the file was
never ignored in the first place, so a plain `add` works the first time and
every time after (`gitignore-recurrence.test.ts`'s third case proves exactly
this: it calls `git add` with no `-f` and asserts the file lands in the
index); (4) mark the `guardrails` CI job required in branch protection;
(5) publish `guardrails-core` (and the plugin, for Claude Code teammates)
somewhere every teammate's `npm install` can reach it, and have everyone
reinstall so `prepare` re-runs `install-hooks`; (6) set `distribution: "team"`
for the record, though nothing currently reads it. No step here is a code
change to `guardrails-core` itself — the one code change this task found
necessary (the gitignore fix above) was already shipped by the time this
procedure needed it, closing the gap the original claim glossed over.

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
  - **Copilot fixer tier-ladder is config-gated, and `model:` is deliberately
    unset by default — this is safe, not an oversight.** `scripts/sync-agents.mjs`
    emits `.github/agents/*.agent.md` with the `tools` allowlist and `agents: []`
    wired, and writes a `model:` line from
    `RepoConfig.copilotFastModel`/`copilotThoroughModel` when those knobs are set.
    They default UNSET because of how Copilot actually treats the field per
    surface (GitHub docs, mid-2026):
    - **VS Code / JetBrains / Eclipse / Xcode:** unset `model:` **inherits the
      model selected in the picker** (the session model). So the _thorough_
      fixer is **never silently downgraded** — it rides whatever the user
      selected; the only cost is that the _fast_ fixer isn't pinned to a cheaper
      tier (it also inherits). Pinning a tier requires an explicit `model:`.
    - **Copilot CLI:** the `model:` frontmatter field is **ignored** (uses the
      CLI's own default model); a `model:` **array even errors** the agent as
      malformed. So a single-string value is safe (ignored) but can't pin a tier
      there today (tracked upstream: github/copilot-cli #2133/#3070).
    - **Cloud coding agent:** `model:` is **not honored** at all — the model
      comes from the GitHub.com UI selection or "Auto".
    - **No enumerated id list:** GitHub publishes none; valid values are
      surface- and account-specific (IDE autocomplete, e.g. `Claude Opus 4.5`)
      and drift over time — the same drift risk as the third-party rule-ids
      (see the "Upgrading leveraged tools" note). Hardcoding a default would be
      fragile (a wrong id can fail agent load), so the knobs stay unset and a
      user who wants VS-Code tier-pinning sets them from their IDE's autocomplete
      list in `guardrails.config.json` and rebuilds — no code change needed.
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
  - **Update (Phase C piece 3 — resolved: this is NOT lint-gateable).** The
    lint-rule route above was investigated and rejected. The upstream rule that
    already implements it — `@typescript-eslint/no-unsafe-type-assertion` — cannot
    distinguish "cast then validate" from "cast and trust": it flags every narrowing
    assertion, including the sanctioned parse-don't-validate guard idiom (proven on
    this repo — 23 findings, ~all safe guard/generic casts). Narrowing it to the
    syntactic `JSON.parse(x) as T` form trades those false positives for false
    negatives (misses the two-line `const p = JSON.parse(x); p as T` form). There is
    no reliable **and** complete lint gate; the property needs dataflow the linter
    lacks. **The reliable, by-construction fix is a runtime validator**
    (`schema.parse(JSON.parse(x))` — zod/valibot/typia — returns a typed value with
    no cast to detect). So this concern is **a recommendation, not a gate**: the
    Phase E scaffolder's shipped template should adopt a validator at trust
    boundaries, and fixer/scaffold guidance should point boundary casts there rather
    than at deletion. The diff-auditor's existing `as any` / `as unknown as`
    rejection stays (that pattern _is_ reliably detectable — it's the explicit
    escape hatch, not the laundering cast). Full investigation:
    `docs/superpowers/specs/2026-07-21-phase-c-boundary-cast-rule-design.md`.

## Roadmap: fixer-loop hardening (from the dogfooding live proof)

The first live run (assertionless test → escalation → correct fix) validated the
escalation ladder but surfaced improvements. Two are implemented on the
dogfooding branch (built-in loose-rule routing so test-integrity rules go to the
thorough tier from attempt 1; a `Read`-matcher scope-check denying the fixer
reads outside `repoRoot`). One remains:

- **State dir is cwd-relative, not git-root-relative — recurrence ledger
  fragments (found Phase C piece 3, unfixed).** There is **no git-root
  resolution anywhere in `src`**: `cli.ts` sets `cwd: process.cwd()` and every
  handler computes `repoRoot = input.cwd ?? deps.cwd`, so
  `stateDirectory(repoRoot)` resolves to `<cwd>/.guardrails/state`. Operating the
  same repo from different working directories — a subdir session, a manual
  `guardrails` CLI run, a drifted cwd — therefore writes to **different**
  `.guardrails/state/` dirs, so `recurrence.json` (the repeat-offender ledger
  that drives loose-routing/graduation) silently **fragments and undercounts**.
  Two facets: (1) **correctness** — recurrence is keyed to the invocation
  directory rather than the repo; (2) **hygiene** — `.gitignore`'s
  `.guardrails/state/` is a mid-separator (root-anchored) pattern, so nested
  `.guardrails/` dirs from non-root cwds escape it and can be accidentally
  committed (confirmed: `git status` showed a stray
  `guardrails-core/src/.guardrails/` as untracked). **Fix direction:** resolve
  `repoRoot` to the git toplevel (`git rev-parse --show-toplevel`, through the
  injected `exec`) rather than trusting cwd, so all state anchors at the true
  root regardless of invocation directory; this also subsumes the previously-noted
  "broaden the root-anchored gitignore" follow-up (Phase C piece 2 findings). TDD
  a `resolveRepoRoot(exec, cwd)` seam with a fake exec.

- **`Stryker disable next-line` silently misses a prettier-wrapped statement —
  found on PR #19, fixed there by removing the need for it; the drift-guard is
  still open.** Stryker matches a disable comment by **(mutator, line number)**,
  so `// Stryker disable next-line ConditionalExpression` above a statement that
  prettier has wrapped onto two lines lands on the first line — often a bare
  `const files =` with no mutants at all — while the mutated expression sits on
  the next line, unsuppressed. `cli-core.ts` carried exactly this: an
  eight-line, carefully argued equivalence note whose annotation had not been
  in effect since the statement was wrapped. It fails **quietly in the worst
  direction**: the recorded argument reads as active to every subsequent
  reviewer, while the gate reports the mutant as a live survivor that looks like
  new debt. The PR-#19 instance was resolved without a suppression at all — the
  duplicated `filePaths ?? filePath` shape was extracted into a tested
  `hookFilePaths()` seam, which makes the `[]`-vs-`[undefined]` distinction
  observable and the mutants genuinely killable — but the trap remains for the
  other ~25 `disable next-line` sites. **Fix direction:** extend the drift-guard
  (`test/drift/registry.test.ts`) to parse every `// Stryker disable next-line
<mutators>` in `src/` and assert the following line actually carries a mutant
  of each named mutator in the current report; a suppression that matches
  nothing is either misaligned or stale, and both should fail the build. Same
  class as the generated-`.claude/agents` trap: a formatter rewriting code that
  another tool keys on by line.

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
  documented in `audit.ts`:** the lexer is single-line only, so multi-line
  `/* ... */` block / JSDoc comments cut **both** ways — a directive suppression
  hidden in a multi-line comment body is missed (under-match / false negative),
  **and** a continuation line that merely _mentions_ a code-class token
  (`@Disabled`, `@SuppressWarnings`, `as any`, `.skip`) in prose is lexed as
  code and **over-matches** (false positive) — the latter is the more likely
  trigger for Phase-D Java's idiomatic Javadoc, and blocks a turn on legitimate
  documentation. (A template literal nested _inside_ another template's `${...}`
  interpolation is likewise skipped as an opaque string span rather than
  recursively lexed.) Both are structurally fixed by the roadmapped AST auditor
  (below), which tracks open-comment state across lines. Also noted while auditing the commit path — **now shipped (Phase E piece
  2):** `gate --mode=commit` and `gate --mode=pretooluse` honor
  `RepoConfig.enforcement` (`"warn"` vs `"block"`). Under `warn` both still
  run the gate and report violations/findings in full; only the exit code
  (`--mode=commit`) or the deny-payload-vs-stderr choice (`--mode=pretooluse`)
  changes, and each says outright that it is not blocking. `enforcement` is
  consulted only in `cli-core.ts` — it governs the commit/preToolUse surfaces
  alone, `toGateConfig` still does not forward it, and the Claude Code Stop
  loop is deliberately never softened by it. This repo sets its own
  `enforcement` to `"block"` in `guardrails.config.json`, since the default is
  `"warn"` and leaving it there would have made this repo's own gate advisory.

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

- **Tool/language-upgrade drift guard (first cut shipped, Phase C piece 1).**
  `guardrails-core` hardcodes third-party rule-ids/signatures in two places —
  the loose-class list (`loose-rules.ts`) and the diff-auditor suppression
  signatures (`audit.ts`) — plus, on the Copilot side, model identifiers (above)
  that also drift. `CLAUDE.md`'s "Upgrading leveraged tools" section already
  documents _which_ files to review on a linter/test/language bump, but that
  relies on a human remembering. Mechanize it: prefer a **deterministic check**
  over an "upgrade agent" — a test (or Dependabot-triggered CI step) that asserts
  every rule-id referenced in `loose-rules.ts` still exists in the installed
  plugin's rule set and that the auditor's suppression syntaxes still match the
  tool's current output, so a rename/removal **fails the build** instead of
  silently mis-routing or under-matching. Value grows as Phase C/D add many more
  analyzers (knip, dependency-cruiser, semgrep, stryker, pmd, spotbugs, …), each
  with its own hardcoded ids. A skill could complement it for the judgment part
  (spotting newly-added rules that _should_ be classed loose), but the
  drift-detection itself should be a gate, not advice. **Shipped:** knip issue
  types + the resolvable eslint-family loose ids now have an id-existence probe
  (`src/drift-guard.ts` + `test/drift/`, see the Phase C status below);
  `audit.ts`'s suppression-signature drift is the documented next registry
  entry.

- **Drift-guard finding: `no-assertionless-test` resolves to no installed
  plugin.** `loose-rules.ts` `LOOSE_RULE_NAMES` lists `no-assertionless-test`,
  but no installed ESLint plugin provides it (checked while building the
  drift-guard). Likewise `boundaries/` has no installed plugin. Both are
  excluded from the drift-guard's asserted set and documented as
  forward-declared in `test/drift/registry.test.ts`; move them into `knownIds`
  when their plugins land. Harmless today (a loose name matching nothing never
  classifies anything), but recorded so the entries aren't mistaken for live.

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

## Roadmap: analyzer opt-in (pack composition, not all-or-nothing) — shipped

Phase E piece 1 shipped the hybrid this section used to guess at:
installed-means-enabled by default, with an explicit `guardrails.config.json`
`analyzers` block (keyed by tool name, values `off` / `auto` / `required`, with
`true`/`false` accepted as shorthand for `required`/`off`) that promotes a tool
to `required` and so restores a hard `guardrails/analyzer-missing` error for
anyone who wants it. The full truth table — off if the config says off,
otherwise it runs if it is there, and a missing binary is an error only if it
was asked for, in `analyzers` **or** in the repo's own `package.json` — is
`decideAnalyzer` in `guardrails-core/src/verify/analyzer-policy.ts`; the design
is `docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md` §3. That
declared-in-`package.json` clause is specifically what closes the
silent-degradation hole this section worried about: a provider the repo names in
its own manifest but whose binary will not start is a broken install and still
errors, not a quiet opt-out.

- **Known limit — root-manifest-only declared providers.** `declaredProviders`
  reads `<repoRoot>/package.json` and nothing else. A monorepo that declares its
  analyzer dependencies in member packages rather than at the root therefore has
  an empty declared set: every analyzer is `auto`+undeclared, and a broken
  install degrades silently instead of erroring — the exact failure the
  declared-provider clause above exists to prevent, in a layout this project
  otherwise supports. The workaround is to mark those analyzers `"required"` in
  `guardrails.config.json`, which states the dependency explicitly and restores
  the hard `guardrails/analyzer-missing` error. Fixing it properly means
  deciding _which_ member manifests count (all workspaces? only those matching
  the changed files?), which is a design question, not a cleanup — hence
  recorded here rather than patched. See the comment at the `declaredProviders`
  call site in `guardrails-core/src/verify/index.ts`.

Related: the mutation **survivor baseline** (Phase C piece 4 findings) is the same
shape of problem — a pack member that is unusable on day one of adoption unless
there is a ramp. That baseline remains out of scope for this phase.

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

## Phase C status (in progress)

- **Piece 1 — knip + drift-guard (shipped).** knip runs at the commit/ci rungs
  via a new `VerifyOptions.profile` seam; a `parseKnipJson` adapter maps its
  output to `Violation[]` (`fixable: false` — knip `--fix` deletes code). The
  drift-guard (`src/drift-guard.ts` + `test/drift/`) asserts the knip issue
  types and the resolvable eslint-family loose ids still exist upstream.
  Design: `docs/superpowers/specs/2026-07-18-phase-c-knip-drift-guard-design.md`.
  - **Dormant loose-class (by design):** knip is loose-classed but runs only on
    the block-only commit rung, so that thorough-tier routing is inert until the
    throttled Stop tier (option B) lands. Do NOT read the `knip/` loose entry as
    live behavior yet.

### Phase C piece 1 — execution findings

- **Drift-guard finding: `no-assertionless-test` resolves to no installed
  plugin.** `loose-rules.ts` `LOOSE_RULE_NAMES` lists `no-assertionless-test`,
  but no installed ESLint plugin provides it (checked while building the
  drift-guard). Likewise `boundaries/` has no installed plugin. Both are
  excluded from the drift-guard's asserted set and documented as
  forward-declared in `test/drift/registry.test.ts`; move them into `knownIds`
  when their plugins land. Harmless today (a loose name matching nothing never
  classifies anything), but recorded so the entries aren't mistaken for live.
  (Also recorded under "Roadmap: fixer-loop hardening" above.)
- **Plan code must be validated against the target repo's own linter.** The
  plan's `parseKnipJson` tripped `sonarjs/cognitive-complexity` (23 > 15) and
  `unicorn/prevent-abbreviations` when written as drafted; fixed by decomposing
  into helpers and renaming (fix the code, not the rule). Separately,
  `@typescript-eslint/no-unnecessary-boolean-literal-compare` autofixes
  `x === false` → `!x` for a boolean field, so exact-literal assertions like
  `fixable === false` aren't achievable in-repo (use `!x`; pin the exact
  literal via object-equality assertions instead).
- **A knip fixture under a workspace's test glob pollutes the main analysis.**
  The drift-probe fixture at `guardrails-core/test/drift/knip-fixture/` (which
  needs a deliberately-unused export) was swept into guardrails-core's
  `test/**/*.ts` scope and had to be excluded from FOUR configs —
  `knip.json` (`ignore`), `guardrails-core/tsconfig.json` (`exclude`), root
  `eslint.config.js` (`ignores`), and (found only when Task 5 ran the pre-push
  gate for the first time since Task 4 — the gate runs at push, not per-commit,
  so this slipped Tasks 1–4 unnoticed) root `.fallowrc.jsonc`
  (`ignorePatterns`) — all scoped to `test/drift/knip-fixture/**`.
- **knip's bin isn't on PATH under vitest.** The drift probe had to spawn the
  absolute `node_modules/.bin/knip` path (computed from the test's location),
  not a bare `knip`.
- **A workspace-scoped test importing a root-hoisted devDependency reads as
  "unlisted" to fallow.** `guardrails-core/test/drift/registry.test.ts` imports
  `@eslint/js` directly (to introspect real rule ids for the eslint-family
  probe) but only the root `package.json` declared it; npm workspace hoisting
  made it resolve fine at runtime, masking the gap until the whole-graph
  pre-push gate (which is workspace-aware) flagged it. Fixed by declaring
  `@eslint/js` in `guardrails-core/package.json` directly rather than relying
  on hoisting — same "declare in the workspace that actually uses it" lesson
  as the fixture-exclusion finding above.
- **Zero-`.ts` commits skipping knip was reclassified from "minor follow-up"
  to a real bug, and fixed.** `runVerify` originally early-returned when no
  changed `.ts` files were found, before the knip dispatch — so a
  `package.json`-only (e.g. Dependabot) change skipped knip at every rung,
  including the CI backstop, silently exempting knip's dependency-hygiene
  issue types (`dependencies`, `devDependencies`, `unlisted`, `unresolved`,
  `binaries`). A whole-branch review caught that knip is whole-graph and needs
  no changed-file list, so gating it on a diff-scoped precondition was wrong.
  Fixed by reordering `runVerify`: knip now runs whenever `profile !== 'stop'`,
  independent of `files.length`; only ESLint/tsc stay gated on changed `.ts`
  files.

- **Piece 2 — dependency-cruiser + analyzer registry (shipped).**
  dependency-cruiser runs at the commit/ci rungs via a new min-rung analyzer
  registry in `verify/index.ts` (the `if (profile !== 'stop')` knip branch is now
  a `const ANALYZERS` table; knip + dependency-cruiser are `minRung: 'commit'`
  entries, run serially; ESLint/tsc stay the diff-scoped special case outside the
  table). A `.dependency-cruiser.cjs` declares three teeth-having rules —
  `no-circular`, `not-to-test-from-src`, and `exec-seam` (only `src/exec.ts` may
  import `node:child_process`, enforcing the injected-Exec invariant). A
  `parseDepcruiseJson` adapter maps `--output-type json` to `Violation[]`
  (`fixable: false` — dependency-cruiser has no safe autofix). The drift-guard
  gained a third probe over dependency-cruiser's config-condition keywords +
  severity enum (its rule names are ours, so not a drift target). Orphan/unresolved
  rules were deliberately left off — fallow + knip own dead-code. Design:
  `docs/superpowers/specs/2026-07-19-phase-c-dependency-cruiser-design.md`.
  - **Dormant loose-class (by design):** dependency-cruiser is loose-classed but
    runs only on the block-only commit rung, so thorough-tier routing stays inert
    until the throttled Stop tier (option B) lands — identical to knip.
  - **Registry revisit deferred to semgrep:** the min-rung table models only
    `minRung`, not a diff-scope policy. semgrep (first diff-scopable / possibly
    stop-rung analyzer) and stryker (CI-only) are the trigger to re-evaluate
    whether it must graduate to a fuller per-analyzer abstraction, and to
    reconsider parallel execution under a measured commit-gate budget.

### Phase C piece 2 — execution findings

- **The drift probe went validator-based, not schema-import or fixture (the
  design's "resolved at implementation" open item).** dependency-cruiser 18 ships
  **no consumable JSON schema** (only a precompiled ajv validator with no attached
  `.schema`), and its `exports` map throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on
  subpath `require`/`import` — so the design's preferred schema-introspection probe
  is impossible. But DC's config validator is **strict** (`additionalProperties:
false`, enforced severity enum), so the probe feeds a minimal config per keyword
  (`circular`, `path`, `pathNot`, `dependencyTypes`) + per severity to DC's own
  validator (imported by computed internal path, mirroring the eslint.config.js
  import) and asks which still validate. This is **fixture-free** — strictly better
  than the design's fixture fallback, which would have re-incurred piece 1's
  "fixture pollutes four configs" problem.
- **DC's tsConfig path must be absolute in `.dependency-cruiser.cjs`.** A relative
  `tsConfig.fileName` trips a dependency-cruiser + TypeScript `extends`-resolution
  path-doubling bug (the tsconfig path shares the `guardrails-core` segment with
  DC's computed basePath → TS5083/TS18003, depcruise exits 1 with 0 modules cruised
  before any rule runs). Fixed with `resolve(__dirname, 'guardrails-core/tsconfig.json')`.
  Verified against dependency-cruiser 18.1.0 + typescript 5.9.3.
- **The hand-authored `.dependency-cruiser.cjs` breaks typed ESLint.** It lives
  outside any tsconfig, so ESLint's project service can't parse it — added to the
  global `ignores` in `eslint.config.js` alongside the existing `*.config.js/ts`
  entries (a tool config, same class), required for the `npm run lint` clean
  baseline.
- **`noUncheckedIndexedAccess` bit the adapter's tests, and vitest hid it.**
  Plan-example test code used `const [v] = parseDepcruiseJson(...); v.prop`, which
  is `TS18048` under the repo's `noUncheckedIndexedAccess` — but vitest (esbuild, no
  typecheck) passed it green, so `npm test` alone missed it; only `npm run typecheck`
  / CI caught it. Reworked to whole-array matchers (`toContainEqual`) like the
  knip-adapter tests. Lesson: pre-validate plan code against `tsc`, not just eslint.
- **`.guardrails/state/` gitignore is root-anchored.** The nested
  `guardrails-core/.guardrails/state/` written by gate runs isn't matched, so it
  could be accidentally committed — a candidate follow-up (broaden the pattern).
- **Analyzer invocations must be consumer-generic, not repo-coupled (PR review
  finding).** The first cut of `runDepcruise` hardcoded `--config
.dependency-cruiser.cjs` and the target `guardrails-core/src` — this monorepo's
  own layout. But the machinery ships into consumer repos where `repoRoot =
deps.cwd` (the consumer's dir), so depcruise would `ERROR: Can't open
'guardrails-core/src'` and break the gate for every consumer — the analyzer's
  primary product use case, silently defeated in dogfooding-only testing. Fixed
  by mirroring `runKnip`: no `--config` (DC auto-detects the consumer's own
  config) and target `.` (the consumer's config matchers + excludes scope it),
  guarded by an orchestrator test asserting the argv carries no repo-specific
  path. **General lesson for the remaining analyzers (semgrep, stryker): the CLI
  invocation must be config-agnostic + layout-generic; dogfooding on this repo
  alone won't surface a this-repo-path assumption — add a "no repo-specific argv"
  test per analyzer.**

- **Piece 3 — the "semgrep slot" resolved to a recommendation, not an analyzer
  (no enforcement code shipped).** Investigation retired both candidate tools and
  concluded the boundary-cast concern is **not reliably lint-gateable**; the fix is
  by-construction (a runtime validator), deferred to Phase E. Design + full
  investigation:
  `docs/superpowers/specs/2026-07-21-phase-c-boundary-cast-rule-design.md`.
  - **semgrep is unusable as a pack analyzer:** not npm-installable (no first-party
    npm package, no standalone binaries — pip/Docker only, so no reproducible Node
    pin); its cross-file/interprocedural taint is **Pro-only** (free-tier taint is
    single-function); its registry rules are **non-redistributable** (Semgrep Rules
    License), so guardrails-core can't bundle packs; and it's ~1.3–1.7s/scan vs the
    ~1.0s serial commit budget. **ast-grep** (npm-native, ~0.01s, MIT) is
    structurally sound but **analytically shallow** (no types/dataflow/taint/registry)
    — no more than the type-aware ESLint we already run. All verified empirically
    (semgrep 1.170.0, `@ast-grep/cli` 0.44.1 installed and tested).
  - **The rule already exists upstream:** the concrete boundary-cast rule the slot
    was for (`plan.md` §"Boundary type-safety") ships as
    `@typescript-eslint/no-unsafe-type-assertion` (type-aware, off-by-default, ts-eslint
    v8.15.0+). So there was never a tool to add — only the question of enabling +
    loose-classifying it.
  - **Dogfood finding — the rule is not a reliable gate.** Enabling it (`npm run lint`)
    produced **23 errors, ~all on the sanctioned parse-don't-validate idiom**
    (`(x as KnipIssue).field` inside type guards; `value as Record<string, unknown>`
    preambles; generic `value as T`; test scaffolding). The rule **cannot distinguish
    "cast then validate" from "cast and trust"** — it flags every narrowing assertion,
    including the standard safe way to author a TS type guard — and this repo forbids
    `eslint-disable`, so a clean enable is unreachable. Three independent confirmations
    that no reliable **and complete** lint gate exists: the dogfood flood; the research
    (the ecosystem uses runtime validators, not linters, for exactly this reason); and
    the false-pos/false-neg trap (narrowing the rule to the syntactic `JSON.parse(x) as
T` form is clean here but misses the two-line `const p = JSON.parse(x); p as T`
    form — the property depends on dataflow the linter can't follow).
  - **Also surfaced: verify against the real gate, not a hand-scoped probe.** The
    design's initial "clean baseline" was a false negative from a probe config lacking
    the real gate's TypeScript program, so the type-aware rule silently under-reported.
    Same class as piece 2's "vitest hid the tsc error." The enable + loose-classify +
    drift changes were implemented TDD-first, then **reverted** once the real gate
    surfaced the flood — shipping half an unreliable gate's machinery (a
    classification that implies "enable this rule") is worse than shipping nothing.
  - **Redirect (Phase-E-owned):** the boundary-safety concern moves to a
    **runtime-validator recommendation** — the scaffolder's shipped template should
    adopt a validator (zod/valibot/typia) at trust boundaries so the safe pattern
    exists by construction (`schema.parse(JSON.parse(x))` produces no cast and needs no
    detection), and fixer/scaffold guidance should point boundary casts there rather
    than at deletion. See §"Boundary type-safety" (product track).
  - **Registry-graduation revisit re-deferred from semgrep to stryker** (the min-rung
    table is untouched; stryker is the remaining Phase-C analyzer and the real trigger).

- **Piece 4 — stryker (shipped).** A diff-scoped, incremental, **commit-rung,
  blocking** mutation gate: any surviving mutant in changed production code is a
  `stryker/survived` violation routed to the thorough fixer. `runStryker` shells
  out consumer-generically (no `--configFile`; `--mutate` is the consumer's own
  changed files) and reads stryker's default report path through a new
  `VerifyOptions.readFile` seam; `parseStrykerJson` maps the
  `mutation-testing-elements` report to `Violation[]` (`fixable: false` — the fix
  is a judgment, never a silent autofix). Drift probe #4 guards the `MutantStatus`
  enum via the schema package's public subpath. Design:
  `docs/superpowers/specs/2026-07-23-phase-c-stryker-design.md`.
  - **Registry graduation resolved** (twice deferred, at dependency-cruiser and
    again at semgrep). `ANALYZERS` now models a `scope` run-trigger
    (`changed-files` | `whole-project`) alongside `minRung`, and ESLint/tsc fold
    into the table — `runVerify` is one uniform loop with no special case. Note
    `tsc` is changed-files-_triggered_ but whole-project-_checked_. Violation
    order changed to eslint, tsc, knip, DC, stryker (no test asserted the old
    order). **Parallel execution is still deferred** — but now measurable rather
    than speculative.
  - **Three unplanned additions** landed with it, each recorded below: the
    sanctions approval flow, the ask-first instruction, and guidance delivery +
    the `crushing-mutants` skill.

### Phase C piece 4 — execution findings

- **`--mutate` is FILE-granular — the design's biggest correction.**
  "Zero-tolerance on changed code" assumed you pay only for code you wrote. You
  don't: touching one line of a file bills you every survivor in it. This
  branch's 7 changed production files carried **140 pre-existing survivors**;
  adding a single field to `config.ts` billed 14, and one line to `cli-core.ts`
  billed 47. They were all killed by explicit choice (see below), but for a
  **consumer repo adopting guardrails this is an adoption cliff** — day one is
  hundreds of survivors in files they have not touched. The fix is an **adoption
  ramp**, not permanent tolerance: baseline on adopt → drive to zero file by file
  → zero-tolerance forever. Phase-E-owned. (The retrofit tax is one-time: under
  the gate from day one, survivors appear two or three at a time, while the
  author still has context — which is also why file-granularity stops mattering
  once every file is clean.)
- **The unique value is catching VACUOUS tests — confirmed three times, twice
  against code written in the same session.** `stryker-adapter.ts`'s original
  four tests passed _for the wrong reason_: every guard fails open to `[]`, so
  `expect(parse(malformed)).toEqual([])` is green even if the guard is entirely
  broken. The fix is to **pair the malformed input with a valid one**, so a
  wrongly-_accepting_ guard emits the valid item and the assertion fails — that
  single change killed 37 survivors. Two more of the same class: a
  `.filter(v => v.tool === 'stryker')` assertion silently dropped a mutant's junk
  return, and a TTL fixture milliseconds old passed under a mutant that shrank the
  TTL to milliseconds. **Nothing else in the pack can catch these** — coverage ran
  the line, `vitest/expect-expect` saw an assertion. Rule of thumb now in the
  skill: **always ship a positive control** alongside a "must not fire" assertion.
- **~19% of survivors are equivalent, and that tax is permanent** — 26 of them,
  at a consistent rate across all seven files, in five recurring families: a
  redundant `typeof` half subsumed by the check below it; a `catch` that falls
  through to the same result; state reset unconditionally right after the mutated
  branch; optional chaining behind a type guard that makes it unreachable; a
  placeholder in a container only ever probed by exact key. Unlike the 140, this
  does **not** shrink with adoption — it recurs on new code forever, and proving
  equivalence produces no test.
- **Directive placement is a real constraint, and it shapes production code.**
  `// Stryker disable next-line` only attaches to a **statement-leading** comment
  — not above a `} else if` or a `} catch {`. `audit.ts`'s metadata branch was
  restructured into an early `continue` purely to give a directive an anchor;
  elsewhere a `disable`/`restore` **range** was required. Always **re-run to
  confirm the directive attached**: one that silently failed leaves the mutant
  `Survived`, not `Ignored`. Use **mutator-scoped** directives
  (`disable next-line ConditionalExpression`), never blanket ones, which discard
  real coverage on the same line.
- **Early runs were nondeterministic** — identical code gave 19 Survived / 10
  Timeout, then 15 / 14. A timeout counts as detected while a survivor is a
  violation, so the _blocking gate itself was flaky_. It resolved once the
  borderline mutants were killed (killing converts both statuses to `Killed`), so
  driving a file to zero also stabilises it — but a partially-hardened file can
  block one commit and pass the next.
- **In-source region exclusion works better than the plan predicted.** The plan
  expected mutator-exclusion to cut `audit.ts` by only ~31%; the in-source region
  directive moved **all 233** hand-written-lexer mutants to `Ignored` while the
  behavioural half stayed mutated. `audit.ts` finished at **0 survivors / 84
  killed**. Whole-repo absolute mutation thresholds remain arbitrary; diff-scoped
  zero-tolerance is the principled, in-work-cycle model.
- **The gate had never actually run.** `node_modules/guardrails-core/dist` was the
  build from the previous session for this entire piece — every "gate passed"
  until Task 7 ran the _stale_ CLI, without stryker, the scope policy, or any new
  auditor signature. `dist/` is gitignored, so **any phase that changes machinery
  must rebuild before trusting the gate**; nothing detects the staleness.
- **knip/fallow reconciliation — three distinct lessons.** (1) Task 1 taught knip
  about the new devDependencies but not fallow, whose dead-dependency check runs
  only at **pre-push**; the gap surfaced as a blocked push several commits later.
  **A new devDependency must be reconciled against knip AND fallow in the same
  task.** (2) **Neither tool can follow a `require.resolve` string argument** — the
  Task-6 stopgaps were reclassified PERMANENT only after empirically attempting
  removal (knip then flagged the package), which is the standard to hold. (3) Once
  `stryker.conf.json` existed, knip's stryker plugin detected the CLI binaries and
  reported the root `ignoreDependencies` as **stale** — removable, and removed.
  Stale-ignore hygiene is mechanized for knip; it is **not** for
  `sanctionedSuppressions` (open item below).
- **Plan code vs the repo's own lint, three more instances.**
  `sonarjs/no-undefined-argument` rejects a trailing explicit `undefined` even
  though `unicorn/no-useless-undefined` is configured with `checkArguments: false`
  — **a relaxation on one plugin does not imply the other**. `arg` is not in
  `prevent-abbreviations`' allowlist although `args` is. And the plan's
  `run: (o, r) => runTsc(o, r)` wrappers were both unnecessary (TypeScript accepts
  a function with _fewer_ parameters) and unlintable (`o`/`r`).
- **Adding one optional contract field cascaded.** `Violation.guidance` pulled
  `isViolation` into the changed set, exposing 11 survivors in a validator nothing
  had tested clause-by-clause (now table-driven: each case violates exactly one
  clause). The added clause then pushed it over the cognitive-complexity gate,
  forcing a decomposition into `hasRequiredFields`/`hasValidOptionalFields`. Both
  gates caught real problems in one change.

### Dogfooding finding: our own git-simulating tests escaped under mutation

**Scope: this repo's test design. Not a product concern.** Recorded because it
cost two recovery cycles and the mechanism is non-obvious, not because consumers
inherit anything.

`end-to-end.test.ts` builds a real git repo in a temp directory and runs
`init`/`add`/`commit` against it, to exercise the gate end to end. That is a
specialised thing to do, and it collides with mutation testing: the test's
isolation rested on `options.cwd` and `options.env`, both honoured inside
`src/exec.ts` — which the mutation gate mutates. Stryker's sandbox sits at
`.stryker-tmp/` inside the repo, so a mutant dropping `cwd` let git discovery
walk up to the real `.git`. A run committed the temp fixture's tree onto the
branch: 122 files deleted, `src/seed.ts` added. Recovered with `git reset`;
nothing lost, never pushed.

Two things worth remembering:

- **Killing the mutant does not undo its side effect.** Those `cwd` mutants were
  already being killed by `exec.ts`'s own tests. The damage lands while stryker
  _evaluates_ the mutant, before it is reported dead. Coverage cannot prevent
  this; only making the side effect impossible can.
- **`--git-dir`/`--work-tree` do not override `GIT_INDEX_FILE`.** Pinning the
  calls in argv was the obvious fix and it is insufficient on its own: under a
  git hook the environment carries an absolute `GIT_INDEX_FILE` (notably
  `git commit -a` points it at `.git/index.lock`), every descendant inherits it,
  and the env-dropping mutant falls back to that inheritance. Verified in
  isolated temp repos: a fully argv-pinned `git add` aimed at repo B rewrote
  repo A's index. That is also the better explanation of the incident signature —
  mass deletion plus one added file is what an index rewrite looks like.

**Fix (test-file only, so the mutation engine cannot reach it):** scrub `GIT_*`
from the test worker's own `process.env` at module scope — closing the
inheritance channel argv cannot reach — and keep the argv pinning, which covers
the disjoint `cwd`-dropping mutants.

Related note for `crushing-mutants`: a test's containment must not live in code
the mutation engine mutates. Cheap to say; not worth shipped machinery.

### Finding: mutation suppressions are far coarser than they look

**A sanction always grants more than its description.** Measured on
`stryker-adapter.ts` by stripping its directives and re-running:

|                    | killed | ignored | survived |
| ------------------ | ------ | ------- | -------- |
| with directives    | 61     | 31      | **0**    |
| directives removed | 76     | 12      | **4**    |

Only **4** mutants genuinely survive — exactly the four analysed as equivalent
and approved. Suppressing them silences **19**: fifteen genuinely-killed mutants
go along as collateral. The tests still kill them, so no coverage is _lost_ — but
every "zero survivors" report on such a file verifies substantially less than it
claims, and the human who approved four exemptions actually granted nineteen.

Two independent mechanics cause this, both confirmed in this repo:

1. **Directives match by (mutator name, line), not by sub-expression.** On a
   compound condition like `typeof v === 'object' && v !== null && …`, every
   clause shares a start line with the whole chain, so a
   `disable next-line ConditionalExpression` silences all of them.
2. **A `restore` only binds if a statement follows it.** One placed after a
   `return` never attaches, and its `disable` then runs to **end of file**. That
   bug hid 21 mutants across four functions in `gate.ts` — including the
   anti-cheat core — while the report read zero survivors.

**Remedy (proven, used to land piece 6's adapter hardening):** reorder the
`&&`/`||` chain so the equivalent clause is _not_ leftmost, putting it on its own
line where a directive lands on it alone. Verify null-safety survives the reorder
— it does when the null check still precedes every property access, since
`typeof` never dereferences. For a `try`/`catch` range, ensure the `restore`
precedes a real statement; note Prettier will collapse `}\ncatch {` and relocate
the comment, defeating the directive, so those sites need `// prettier-ignore`.

**Always measure the collateral:** record per-file `Ignored` and `Killed` before
and after adding a directive. `Ignored` must rise by exactly the number of
mutants intended and `Killed` must not drop. Losing real coverage to silence an
equivalent mutant is a worse trade than leaving the mutant.

**Known debt:** directives were applied the coarse way across `audit.ts`,
`config.ts`, `gate.ts`, `violation.ts`, `cli-core.ts`, `verify/index.ts`,
`stryker-adapter.ts` and `workspaces.ts` before the remedy was found. Deferred as
its own piece: it is degraded measurement rather than lost coverage, and fixing
it means clause reorderings across eight files, each re-triggering the
file-granularity gate.

### Sanctions — the diff-auditor's escape hatch (shipped in piece 4)

`sanctionedSuppressions` exists because mutation testing produces
provably-equivalent mutants that no test can kill. It is the only way past the
diff-auditor, so granting one is itself controlled.

- **Every entry carries a `reason`, and parsing FAILS CLOSED** — an entry missing
  a key or a non-blank justification is dropped, so an unjustified exemption
  simply does not apply and the gate keeps blocking. A bare key is unreviewable:
  a reviewer cannot tell a proven-equivalent mutant from "the agent got stuck".
- **`guardrails sanctions-check` (CI-only) is the enforcement.** It compares the
  sanction **key set** against the branch's merge-base and fails on any newly-
  requested exemption, so approval is a human reviewing and merging the PR.
  Enforced in CI rather than at the commit gate deliberately: the PR is where
  sign-off actually happens, and local work stays unblocked. Comparing keys (not
  diff lines) keeps it precise — reformatting, rewording a `reason`, or REMOVING
  an entry are legitimate edits that must not trip it.
  - A first cut put a `self-sanction` signature in the **line-based auditor at the
    commit gate**. It was replaced: too blunt (any reformat tripped it) and it
    deadlocked the very branch that introduced it, since merge-base diffs are
    cumulative.
- **An `approvedBy` provenance field was built and then removed.** Local git
  identity is writable by whatever is running and is frequently a bot or a
  placeholder — this repo's own worktree reads `Test <test@example.com>` — so it
  recorded a name that proved nothing while looking like a guarantee. The
  rejection is documented at the seam in `src/sanctions.ts` so it is not rebuilt.
- **The agent must ASK before proposing one** (`CLAUDE.md`): the exact key, why it
  is unavoidable, and what stops being checked. Cooperative and skippable — CI is
  what makes it stick — but it catches a _wrong_ exemption while the context is
  live. The fixer subagents cannot reach the policy file at all (scope-lock), so
  the instruction targets the **main agent**, the only thing that can grant itself
  an exemption.
- **Open — the required-check deadlock.** If `sanctions-check` is made a
  _required_ status check (which the team-mode flip prescribes), it blocks the
  merge that constitutes approval. Needs a label- or review-based pass signal.
- **Open — no stale-sanction detection.** Exception lists only grow. This piece
  already produced one stale entry (a `git.ts` sanction added defensively before
  the file reached zero without needing it), caught by hand. knip does this for
  its own ignores; sanctions have no equivalent.

### Guidance delivery — getting method to the fixer (shipped in piece 4)

Mutation triage is procedural knowledge an agent does not derive, and the failure
mode of not having it is reaching for a suppression. Three layers, because no
single one reaches every runtime:

1. **The violation carries it.** `Violation.guidance` is set by a rule-id prefix
   registry as the gate writes the manifest. The manifest is the **one channel
   every runtime already reads**, so this needs no instruction file and no agent
   cooperation — unlike skills, index docs and instruction files, which are all
   per-surface and voluntary.
2. **Skills also emit as committed docs + a Copilot index.** `sync-agents.mjs`
   writes `docs/guardrails/<name>.md` and a marked block in
   `.github/copilot-instructions.md` naming each doc **with its trigger**
   (progressive disclosure — load only what applies). Committed and CI
   drift-guarded, because Copilot's cloud agent reads the default branch. Content
   outside the markers survives a rebuild.
3. **The thorough fixer names both routes** — the skill where the runtime has
   skills, the doc path where it does not.

- **`crushing-mutants`** is the first skill: killable-vs-equivalent triage, the
  vacuous-assertion traps and the pairing trick, which input defeats each mutator,
  the equivalence families, mutator-scoped directives and their placement rule,
  the ~19% calibration, and the exemption flow.
- **Where to apply this next: mirror `loose-rules.ts`.** "Loose" already means the
  check does not pin the fix, which is exactly when method is needed. **knip** is
  the strongest next candidate (the wrong fix is deleting live code — dynamic
  imports, undeclared entry points), then **dependency-cruiser** (the wrong fix is
  adding a config exception). **ESLint is a poor fit** — guidance would be
  per-rule across thousands, each already documented behind its id. Write a doc
  only where the method is **earned**; thin guidance consumes fixer context and
  teaches nothing, and unlike the drift-guard nothing mechanically checks prose.
- **Open — Copilot has no skill mechanism.** The emitted doc + index is the
  workaround; the scaffolder owns writing both into a consumer repo (Phase E).

### Correction to the Phase B notes

Release-candidate live testing on 2026-09-02 disproved the prior assumption:
Claude Code 2.1.258 did not execute the repo-local fixer-agent frontmatter
`PreToolUse` hook. In `acceptEdits` mode a forbidden `package.json` edit landed.
Scope-check now lives in the session-level plugin/project hooks, like Copilot's
repo hook. It does **not** confine ordinary main-agent work: it activates only
when the payload's exact session has both a violations manifest and the
`.pre-fix.json` marker created for a delegated loop. Clean and escalation remove
that marker; stale and other-session manifests are inactive. A wiring
drift-guard pins this enforceable placement.

- **Piece 6 — workspaces / affected-package attribution (shipped).** The last
  piece of Phase C. A hybrid `loadWorkspaceResolver(repoRoot)`: declared
  workspace members when the root `package.json` declares `workspaces` (npm's
  array form or yarn's `{ packages: [...] }` object form), nearest-ancestor
  `package.json` otherwise; the deepest match wins in either mode, and
  resolution degrades to `undefined` rather than throwing. The package id is
  the repo-relative directory path, never the `name` field. Declared-mode globs
  are matched by a hand-rolled matcher against a small, explicit npm-workspace
  subset (`*`, `**`, a leading `!`) rather than a dependency — the polyglot
  argument: Phase D targets Java/Maven repos, where the usual justification for
  a _declared_ dependency (visible to the consumer's `npm audit`/Dependabot)
  buys nothing at all, which beat even zero-transitive-dep `picomatch`.
  `guardrails-core` still ships an empty `dependencies`. `withPackages` mirrors
  `withGuidance` — preserve-existing, add-no-key, therefore idempotent —
  applied in both `runVerify` and the stop gate. The dead `packageId` parameter
  is deleted from all five adapters and from `VerifyOptions`. Per-package
  recurrence (`package:ruleId`) is now live, pinned by a test proving the same
  rule in two packages tallies separately rather than merging. Design:
  `docs/superpowers/specs/2026-08-29-phase-c-workspaces-design.md`.

### Phase C piece 6 — execution findings

- **`packageId` was a forward-declared seam set by nobody.** Threaded through
  five adapters since Phase A, and no caller ever passed it. Neither knip nor
  fallow could see it, because it was a _parameter_, not an export — dead code
  no analyzer flags. The general lesson: declaring an interface before its
  producer exists creates dead code that survives every dead-code check.
- **The file-granularity cliff hit us directly.** Deleting that dead parameter
  meant touching four adapters this branch had never otherwise changed, which
  billed **71 pre-existing survivors** (verified against baseline: 73 before
  the change, 71 after). 24 tests killed 60; the residual 11 were equivalents,
  approved by the developer in four families. This is the adoption-cliff
  scenario the piece-4 findings predicted, landing on the people who wrote the
  prediction — the strongest evidence yet that the Phase-E adoption ramp is not
  optional polish.
- **Deleting redundant code beats suppressing it.** Two guard operands
  (`relative.length === 0`, `current !== '.'`) turned out provably redundant
  given `path.dirname('') === '.'` and `path.dirname('.') === '.'`; deleting
  them removed the mutants entirely rather than silencing them, avoiding the
  collateral a directive would have cost on the same line. Prefer deletion
  when the code is genuinely dead.
- **The plan's own tests were the weak ones, three times over.** A canary test
  ("Stryker was here") whose kill power depended on a tool internal was hollow
  in waiting and was removed with the developer's approval. An "is idempotent"
  test was not self-sufficient — the resolver is deterministic, so it would
  pass against a broken implementation; the real coverage came from a separate
  "does not overwrite" test plus the 0-survivor mutation run. A wiring
  regression test was hollow as proof of wiring — with a nonexistent
  `repoRoot` the resolver always returns `undefined`, so it would pass even
  with the wiring absent (intentional, since it guards degrade-safely rather
  than integration, but still not proof of the thing its name claims). All
  three were specified by the implementation plan; every test an implementer
  wrote to kill a specific mutant was sound. Tests written to specify intent
  tend to restate the happy path; tests written to kill a mutant must
  distinguish two behaviours. Worth carrying into how future plans are
  written, not just this one.

Two more findings from this piece are recorded under their own headings above,
not repeated here: the git-corruption incident during mutation testing ("Dogfooding
finding: our own git-simulating tests escaped under mutation") and the
suppression-coarseness measurement ("Finding: mutation suppressions are far
coarser than they look").

### Finding: the mutation gate was fail-open on uncovered code

Surfaced during the final PR review of Phase C, from a stray `NoCoverage` count
in a mutation report.

**What was wrong.** `stryker-adapter.ts` emitted a violation only for mutants
with `status === 'Survived'`. Its header justified discarding `NoCoverage` with
"left to the coverage gate". **No such gate exists** — not in this repo, and not
in a consumer repo:

- `vitest.config.ts` configures a coverage _reporter_, but no `thresholds`, so
  nothing fails on a coverage drop.
- `check:graph` runs `fallow`, a churn/complexity hotspot tool. It has no
  coverage assertion and exited 0 throughout.

So code that **no test executed at all** passed every gate in the stack. This is
the same class of defect as the three fail-open paths closed earlier in this
phase (analyzer exit codes, git exit codes, the stryker double fail-open) — the
gate reported clean because a signal was discarded, not because it was checked.

**Why it mattered here.** Statement coverage read a healthy 94.22% the whole
time, while these were untested:

- `autofixCommand` — the entire PostToolUse hook entry point, which runs on
  every edit in a guarded session.
- `stopHookReason` — public API (exported from `index.ts`), the text a consumer's
  Stop hook shows the agent.
- `spawnExec`'s `child.stderr.on('data')` handler — the only path that captures
  stderr from a process that actually runs. The existing stderr assertion covered
  the _spawn-error_ path instead, which fills `stderr` from the `error` event.
  So "First line of stderr", the diagnostic `analyzerFailedViolation` was built
  on in this same phase, had never been proven to work end to end.

That last one is the sharpest lesson: a fail-closed diagnostic added in this
phase depended on an uncovered line, and nothing noticed.

**The numbers.** On the full report at the time of the finding:

| Metric                                                     | Value   |
| ---------------------------------------------------------- | ------- |
| Mutation score of **covered** code (what we gated on)      | 100.00% |
| Mutation score, **standard** (`NoCoverage` counts against) | 98.62%  |
| Mutants in code no test executes                           | 16      |

**Covering them found a real bug in the tests.** Writing tests for the uncovered
regions immediately turned one of them into a genuine `Survived` mutant in
`cli-core.ts` that had been invisible while the region was uncovered. Coverage
gaps do not merely hide untested code — they hide _mutation findings_.

**Fix (shipped).** `NoCoverage` is now reported as `stryker/no-coverage`, a
distinct rule id from `stryker/survived`, because the remedies differ (write a
covering test vs. strengthen an existing assertion) and the fixer routes on rule
id. `crushing-mutants` gained a section contrasting the two, including the rule
that a `no-coverage` mutant must never be argued equivalent: equivalence is a
claim about behaviour under a test that _runs_ the code.

**Why not a coverage threshold.** Considered and rejected:

- A threshold is an **aggregate**. It permits any individual line to stay
  uncovered while the percentage looks fine — exactly what happened here at
  94.22%.
- Mutation already locates the gap **per line** and **diff-scoped**, so it only
  ever flags code the agent just touched. A threshold is inherently
  whole-project and ratchets badly.
- Zero new tool, config, or dependency — which the zero-runtime-dependency and
  polyglot-consumer goals both care about.

Mutation testing subsumes the coverage threshold. We were discarding the answer
it already computed.

**Consumer-visible.** This makes the pack stricter: a consumer adopting the
stryker analyzer will now see `stryker/no-coverage` on changed files that have
untested lines. That is the intended behaviour, but it is a behaviour change to
call out in release notes rather than ship silently.

### Dogfooding finding: single-file `stryker --mutate` reports false survivors

Found while executing Phase E pieces 1-2, where per-task mutation checks were
run file-by-file to catch survivors early rather than at the commit gate.

`npx stryker run --mutate <one file>` is **not** a faithful preview of what the
commit gate will report. Two distinct problems:

- **False survivors.** The vitest runner loads only the test files it considers
  related to the mutated file, so mutants killed by a test elsewhere in the
  suite are reported as surviving. The direction is safe — it over-reports, never
  under-reports — so a clean `0 survived` from a single-file run can be trusted,
  but a reported survivor must be re-checked before anyone spends time proving it
  equivalent or (worse) asks for a suppression.
- **Cache poisoning.** The run writes `reports/stryker-incremental.json`, and a
  later run over a different file set reads that state back. Delete that file
  before re-verifying, or the false survivor persists across runs.

**Practice:** treat a single-file run as a cheap early filter. Before acting on
any survivor it reports — and always before proposing a `sanctionedSuppressions`
entry — delete `reports/stryker-incremental.json` and re-run over the gate's own
changed-file set. Two of this plan's three escalations to the developer were
resolved by restructuring instead of exemption; a false survivor that reached
that conversation would have spent the developer's attention on a mutant that
was already dead.

## Phase E status (in progress)

- **Piece 1 — analyzer opt-in (shipped).** See "Roadmap: analyzer opt-in"
  above: `analyzers` in `guardrails.config.json` (`off`/`auto`/`required`, with
  `true`/`false` accepted as shorthand), decided by `decideAnalyzer` in
  `guardrails-core/src/verify/analyzer-policy.ts`.
- **Piece 2 — `enforcement` honored by the commit and preToolUse gates
  (shipped).** `gate --mode=commit` and `gate --mode=pretooluse` read
  `RepoConfig.enforcement` (`"warn"` vs `"block"`); under `warn` both still run
  the gate and report violations in full, only the exit code / deny-payload
  choice changes. The Claude Code Stop loop is deliberately never softened by
  it. See the note under "Roadmap: fixer-loop hardening" above.
- **Piece 3 — packaging + release (shipped).** `guardrails-core` ships as a
  GitHub Release asset (`npm i -D <release-url>/guardrails-core-X.Y.Z.tgz`),
  built by a tag-triggered `.github/workflows/release.yml`.
  `scripts/smoke-tarball.mjs` packs the real tarball, installs it into a
  throwaway repo the way a consumer would, and runs the CLI from there — every
  other test in the suite runs against the npm-workspace symlink, which
  bypasses `files`, the bin shebang, and ESM resolution entirely.
- **Piece 4 — `guardrails init` (shipped).** `detect()` reads the target repo
  (base branch, which config files already exist, the scaffold manifest,
  declared analyzer providers) with no writes; `planScaffold` is a pure
  function from those facts plus the desired file map to a `ScaffoldPlan` —
  every filesystem decision is provable without touching disk; `applyScaffold`
  executes the plan through an injected filesystem seam. `init` alone never
  writes: `--plan` (the default, including a non-TTY invocation — spec §6.2)
  only prints the plan, and `--apply` is the only way past that. A separate
  `guardrails install-hooks` command (invoked automatically via the
  `package.json` `prepare` script `init --apply` wires in) is what actually
  points `core.hooksPath` at `.githooks` on a fresh clone or a teammate's
  checkout, so the pre-commit gate activates without anyone running a command
  by hand.

  Every path `init` manages falls into one of three classes (spec §6.4):

  - **OWNED** (the fixer agent files, `.githooks/pre-commit`,
    `.github/hooks/guardrails.json`, and the `docs/guardrails/*.md` guidance
    docs copied from the packaged `guidance/` tree) — absent → create;
    unmodified since it was scaffolded (its content still matches the sha256
    recorded for it in `.guardrails/scaffold.json`) → silently rewritten on
    upgrade; edited by the consumer → left alone and reported as `drift`,
    unless `--force`, which always overwrites. Content that already matches
    the desired bytes is `unchanged` regardless of what the manifest says,
    checked before the checksum comparison.
  - **SHARED** (`.claude/settings.json`, `.gitignore`, `package.json`,
    `.github/copilot-instructions.md`) — absent → create the whole file;
    present → always `merge`, never `drift` and never sensitive to `--force`.
    Each path's merger touches only guardrails' own entries (hook blocks
    identified by a command marker, the `scripts.prepare` string, a gitignore
    stanza, a marked doc section) and leaves the rest of the consumer's file
    untouched. `applyScaffold` skips the write entirely when the merged result
    is byte-identical to what's already on disk, which is what keeps a re-run
    of an up-to-date repo a no-op even though `--plan` reports `merge` for
    these paths every time.
  - **SEED-ONCE** (`guardrails.config.json`, and `.dependency-cruiser.cjs` /
    `stryker.conf.json` when that analyzer is enabled and no config exists
    yet) — absent → create; present → `unchanged`, forever, even with
    `--force`. `guardrails.config.json` holds the consumer's policy and their
    sanctioned suppressions, so it is the one class `--force` can never touch.

  `.guardrails/scaffold.json` is the manifest behind OWNED drift-tracking: a
  sha256 checksum per OWNED path plus `guardrailsVersion`, stamped from the
  running package's own `package.json` (never from what was previously
  recorded), rewritten whenever an `--apply` writes at least one OWNED file.

  **Known limit — the `.claude/settings.json` merger always re-serialises.**
  `mergeClaudeSettings` (`guardrails-core/src/scaffold/merge.ts`) calls
  `JSON.stringify` on every merge unconditionally, unlike
  `mergePackageJsonScripts`, which builds the merged object and returns
  `current` unchanged when it deep-equals what was parsed. A consumer whose
  formatter disagrees with ours (4-space indent, tabs, different key order)
  gets `.claude/settings.json` reformatted on every `init --apply`, reformatted
  back by their own tooling, and rewritten again next run — forever. The fix
  is the same pattern already used for `package.json`: build the merged
  object, compare its `JSON.stringify` against the parsed input, and return
  `current` unchanged when they coincide. Out of scope for piece 4; recorded
  here so it is not lost.

  **Known limit — orphan files are never reported or removed, and their
  manifest entry persists forever.** A file an earlier guardrails version
  wrote that is no longer in `desired` (renamed, retired) is silently left in
  place by `applyScaffold`. Worse, because `writeManifest` rebuilds
  `.guardrails/scaffold.json` as `{ ...existing?.files, ...manifestUpdates }`,
  that orphan's checksum entry survives every later `--apply` too — there is
  no code path that ever drops a key. This is deliberate, not an oversight:
  deleting a file inside a consumer's repository needs its own design (what if
  they edited it first? what if it moved to a different path in the same
  release?), and is pinned rather than left to silently regress by a labelled
  characterisation test (`init — orphan files from an older scaffold`,
  `guardrails-core/test/scaffold/init-command.test.ts`).

  **Resolved — `.github/copilot-instructions.md` is scaffolded.** An earlier
  draft of this section recorded its absence as a known limit: the block it
  splices in is a progressive-disclosure index ("read this doc when this
  trigger applies"), and the per-doc trigger text needed to live somewhere
  the packaged `guidance/` tree didn't yet ship it. That shipped in `7a2b97a`
  ("ship skill descriptions in guidance/, build the Copilot index"): the
  packaged `guidance/index.json` now carries each skill's description,
  `templates.ts`'s `copilotInstructionsBlock` builds the marked index block
  from it (excluding `adopting-guardrails`, the one skill that explains
  adoption rather than participating in it — see `ADOPTION_TIME_SKILL`), and
  `.github/copilot-instructions.md` is a fourth SHARED path (`merge.ts`'s
  `SHARED_MERGERS`), listed above. This paragraph previously went stale for
  several commits after the fix shipped — a reminder to update this section
  in the same commit as the fix, not after.

### Finding: the base branch never resolved in CI — every PR run was fail-open

Surfaced by CI on PR #16, immediately after the fail-closed exit-code checks
landed. `guardrails verify` failed with:

```
git exited with code 128 … fatal: ambiguous argument 'main':
unknown revision or path not in the working tree.
```

**What was wrong.** `verify`, `gate`, and `sanctions-check` all passed
`config.baseBranch` (`"main"`) straight to git. GitHub Actions checks a pull
request out as a **detached merge ref** and populates `refs/remotes/origin/*`
without ever creating the base branch locally, so `git diff main` cannot
resolve while `origin/main` can. `fetch-depth: 0` does not help: it controls
history depth, not which local branches exist.

**This had been silently true on every PR.** Before the exit-code checks, a
failing `git diff` returned empty stdout, which read as _zero changed files_ —
so every `changed-files`-scoped analyzer (eslint, tsc, stryker) was **skipped**
and CI reported clean. Only the two `whole-project` analyzers (knip,
dependency-cruiser) ever actually ran on a PR. The comment at
`verify/index.ts:161` had predicted exactly this case; it took the fail-closed
change to make it visible.

The same latent bug sat in the other two consumers, degrading quietly rather
than failing:

- **`sanctions-check`** falls back to the branch name when `merge-base` fails,
  then `git show main:guardrails.config.json` fails too, leaving the known set
  empty — so **all 40 exemptions would report as newly granted.** The one report
  a reviewer relies on to spot a new suppression would have been 40 lines of
  noise on every PR.
- **`gate --mode=commit`** falls back to the staged diff, auditing a narrower
  range than intended.

**Fix (shipped).** `resolveBaseReference(exec, repoRoot, baseBranch)` in
`verify/git.ts` tries the branch as given, then `origin/<branch>`, returning a
`{ ref?, spawnFailed? }` result. All three call sites use it. An unresolvable
base is now a **blocking** `guardrails/analyzer-failed` naming the branch and
saying every diff-scoped check was skipped — never a silent empty diff.

This belongs in the tool, not in each repo's workflow: every consumer running
`verify` in GitHub Actions has this problem, and a fix in our own `ci.yml` would
have left the shipped product broken for them.

**Secondary cleanup.** With `resolveBaseReference` running two git calls before
any diff, git is proven to start before `gitCallFailed` is reached, so its
`spawnFailed !== true` half became unreachable. Mutation testing caught it as
two survivors on otherwise-covered code. The guard was **removed** rather than
suppressed; the "a tool that could not be STARTED is reported only as
`analyzer-missing`" invariant still holds and is still tested.

**Method note.** Two of these five survivors were nearly misdiagnosed. A quick
check — replacing the whole `gitCallFailed` body with `return true` — failed 47
tests, which looked like proof that Stryker was reporting a false survivor. It
was not: the surviving mutants were on the **`result.spawnFailed !== true`
sub-expression**, not the whole return, and the whole-expression mutants were
in fact killed. Reading the mutant's `location` columns rather than its line
number is what settled it. When a mutation result contradicts intuition,
compare the exact mutated **span** before concluding the tool is wrong.

### Hardening: sanction counts are now verified against the source

Suggested by the automated review of PR #16, which observed that `count` is a
hand-entered number with nothing re-checking it: a refactor removing a suppressed
call site without touching `guardrails.config.json` leaves the budget
over-provisioned. Not exploitable — the gate still spends per occurrence, so
nothing net-new gets through — but it silently shrinks how much the auditor is
watching, which is precisely what this escape hatch exists to keep visible.

`sanctionCountDrift` sums each key's declared budget and compares it to the
occurrences actually present, and `sanctions-check` now **fails** on any
mismatch. It blocks for the same reason `malformed` blocks: both are _factual_
errors about the policy file, not judgments about whether an exemption is
deserved — which is the line this command already draws, and why a new grant
still exits 0.

**Counted with the auditor's own machinery.** `auditSource` presents a whole file
to `auditDiff` as an all-additions hunk, so the lexer state (strings, regex,
template literals) and the signature table are the ones the gate enforces with.
Two reasons this matters more than convenience:

- A directive mentioned inside a string literal is not a directive, and only the
  real lexer knows that.
- `// Stryker disable next-line ConditionalExpression` is a strict **prefix** of
  `// Stryker disable next-line ConditionalExpression,BlockStatement`, both of
  which are live keys in this repo. Naive substring counting would score the
  wider directive as an occurrence of the narrower one and over-provision it.

`findingKey` moved to `audit.ts` and is now shared by the gate's budget map and
this guard, so the two cannot disagree about what "the same suppression" means —
reimplementing it here would have been the very drift being guarded against.

A key that escapes the repo (`../`) reads as absent rather than being followed:
the policy file is checked-in text, but it is still input.

**Verified against reality:** at the time this landed, the repo's 29 entries /
28 distinct keys / 40 declared occurrences passed with zero drift, and
artificially inflating one count produced `declared 6, found 1` and exit 1.
Phase E's `json-file.ts` extraction later deleted the two `workspaces.ts`
`BlockStatement` entries along with the code they covered, so the current
figures are **27 entries / 26 distinct keys / 38 declared occurrences** — still
zero drift, which is the guard doing its job across a merge rather than a
number that needed hand-editing.
