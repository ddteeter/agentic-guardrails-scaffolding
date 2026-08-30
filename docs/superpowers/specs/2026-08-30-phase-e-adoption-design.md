# Phase E — adoption: analyzer opt-in, release, and the scaffolder — Design

Phase E, taken **before** Phase D (the Java pack). Phase D would add a second
language pack that cannot be validated on this machine (no JVM) on top of a
composition problem that is still unsolved; real adoption feedback from a Node
project should inform Phase D rather than the reverse.

The bar this phase has to clear is not a feature list. It is: **install
guardrails into a fresh Node/TypeScript repo, answer a few questions, and have a
working guarded loop.** Every decision below is judged against a real adopter,
not against this repo — this repo is the tool's development home and self-hosts
the loop, which makes it unrepresentative in exactly the ways that matter.

## 0. TL;DR

- **Analyzer opt-in is the blocker and lands first.** A `analyzers` block in
  `guardrails.config.json` with three states (`false` / `"auto"` / `"required"`).
  The hybrid from plan.md, made precise: _off if you say off; otherwise it runs
  if it's there, and it's an error if it's missing but you asked for it — in
  `analyzers` **or** in `package.json`_.
- **`enforcement` starts being honored**, on the commit and preToolUse gates
  only. Entirely in the CLI's exit code; no template encodes it. The Claude Code
  Stop loop is untouched.
- **Delivery is npm-only.** The tarball carries hooks, both fixer agents, the
  pre-commit hook, the CI workflow, and guidance as generated templates.
  `guardrails init` writes them into the consumer repo. The Claude Code plugin
  stops being a consumer-facing channel; `guardrails-plugin/` remains the
  build-time single source of truth.
- **`guardrails init` is a CLI command, not a skill.** Deterministic,
  idempotent, headless-safe, so the Copilot CLI, the cloud agent, and CI all
  work. A scaffolding **skill sits on top as the judgement layer** and drives it.
- **Idempotency is a three-class file model** — OWNED (checksum-tracked, drift
  reported), SHARED (merge only guardrails' entries), SEED-ONCE (create, never
  touch).
- **Release is a GitHub Release tarball installed by URL**, with a CI tarball
  smoke test. npm publish is a one-line migration later.
- **Out of scope:** the mutation survivor baseline. Greenfield never pays that
  tax; it is a ramp for legacy code, not a composition question.

## 1. What this phase is not

The candidate scope carried eight items. Three are excluded or narrowed, stated
here so the exclusions are decisions rather than omissions:

- **Mutation survivor baseline — out.** Adopting Stryker on an _existing_ repo
  is all-or-nothing in the same shape as the analyzer pack, but a greenfield
  repo never pays the tax: the tool is present from commit one, so there are no
  pre-existing survivors to ramp past. It is a different problem (a legacy ramp)
  from pack composition (a subset-selection problem) and folding them together
  would produce a worse design for both.
- **Runtime-validator template — narrowed to guidance.** Phase C concluded that
  unvalidated-cast-at-a-trust-boundary is not lint-gateable and redirected the
  concern to "the scaffolder's shipped template should adopt a validator". This
  phase delivers the **guidance** — through Phase C's existing guidance pipeline,
  so Copilot gets it too — but `init` neither installs a validator nor picks one.
  Choosing zod vs valibot vs typia for someone else's repo is a judgement call,
  and this design has a judgement layer to put it in (§8).
- **Solo→team flip — narrowed to verification plus documentation.** Honoring
  `enforcement` is the only _code_ the flip needs and it is piece 2. What remains
  is testing plan.md's standing claim rather than restating it (§9.3).

## 2. Piece ordering

Seven pieces, ordered by dependency.

| #   | Piece                                                               | Why here                                                                             |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Analyzer opt-in — `analyzers` config, `runVerify` gating            | Everything downstream reads this schema: init's questions, the CI template, the docs |
| 2   | `enforcement` honored — commit + preToolUse gates                   | Small and independent; lands with piece 1 for one clean config diff                  |
| 3   | Packaging + release — `files`, tarball smoke test, Release workflow | init's design depends on knowing what actually ships in the tarball                  |
| 4   | `guardrails init` — detect / plan / apply, file classes, manifest   | The deliverable                                                                      |
| 5   | Adoption dry-run checkpoint — adopt into the real greenfield repo   | Findings feed back into piece 4 before it is finished                                |
| 6   | Scaffolding skill — judgement layer; validator guidance rides here  | Needs piece 4 to exist to drive                                                      |
| 7   | CI template, adoption docs, team-flip verification                  | The write-up, once behaviour is settled                                              |

Piece 5 is a **checkpoint, not a deliverable**. It exists because the scaffolder
automates a consumer footprint nobody has ever assembled: this repo self-hosts by
inlining into `.claude/` and hand-maintaining `guardrails.config.json`. Walking
the path manually once, after pieces 1–3 make it walkable, is what keeps piece 4
specified against reality instead of inference. Piece 4 should therefore reach
the checkpoint **reviewable and revisable, not polished.**

**Branch risk.** This phase branches `worktree-phase-c-stryker` (PR #16, open).
Pieces 1–2 touch `config.ts` and `verify/index.ts`, both modified by #16, so a
rebase during review will conflict there. Cheap during design; real once piece 1
lands.

## 3. Piece 1 — analyzer opt-in

### 3.1 The problem

`ANALYZERS` in `guardrails-core/src/verify/index.ts` is a hardcoded table, so
every consumer runs the whole TS pack. `guardrails-core/package.json` marks all
five providers as **optional** peer dependencies, but the runtime treats them as
**mandatory**: a tool that cannot be started yields `guardrails/analyzer-missing`
at `severity: 'error'`, with no config gate. A new Node project that does not
install knip, dependency-cruiser **and** Stryker gets permanently blocked
commits. That severity is correct — a guard that silently did not run is worse
than no guard — but it makes subset adoption impossible.

### 3.2 Schema

`guardrails.config.json` gains an `analyzers` block keyed by the analyzer's
`tool` name:

```jsonc
{
  "analyzers": {
    "eslint": "required",
    "tsc": "required",
    "knip": "auto",
    "dependency-cruiser": false,
    "stryker": "required",
  },
}
```

Three states. `true` is an alias for `"required"`, `false` means off, and an
absent key means `"auto"`.

### 3.3 Truth table

| `analyzers[tool]` | binary resolves | provider declared in `package.json` | outcome                                |
| ----------------- | --------------- | ----------------------------------- | -------------------------------------- |
| `false`           | —               | —                                   | **never spawned**, never reported      |
| `"required"`      | yes             | —                                   | runs                                   |
| `"required"`      | no              | —                                   | `guardrails/analyzer-missing`, `error` |
| `"auto"`          | yes             | —                                   | runs                                   |
| `"auto"`          | no              | yes                                 | `guardrails/analyzer-missing`, `error` |
| `"auto"`          | no              | no                                  | skipped silently                       |

Row 5 is what makes the hybrid safe. The cost plan.md identified for
installed-means-enabled was that "a tool that fails to install degrades silently
— the exact failure piece 5 exists to remove." That case is _detectable_: a
provider named in the consumer's own `package.json` whose binary does not resolve
is a broken install, not an opt-out. Reading `package.json` costs nothing —
`workspaces.ts` already reads it.

The declaration check keys on the analyzer's **`provider`**, not its `tool`
(`typescript` for `tsc`, `@stryker-mutator/core` for `stryker`), across
`dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`.

### 3.4 Mechanism

No new detection mechanism is required. `runVerify` already spawns each analyzer
through `trackSpawnFailures` and inspects `spawnFailed`. `"auto"` keeps doing
exactly that and only changes what it _does_ with a spawn failure — suppress the
`analyzer-missing` violation when the provider is undeclared. `false` is the one
state that skips the spawn entirely (`continue` in the loop, before the rung and
scope checks).

`VerifyOptions` gains an `analyzers` policy record and a `declaredProviders`
seam (injected in tests, read from `package.json` at the resolved repo root in
production). `Analyzer` already carries both `tool` and `provider`, so no table
change is needed beyond the gating.

### 3.5 Unknown keys

An unrecognised key in `analyzers` — a typo such as `"knipp": false` — produces a
**`warn`-severity `guardrails/analyzer-unknown`** violation naming the key and
the valid set. It does not block. A typo that silently leaves an analyzer
required while the author believes it disabled is precisely the trap this phase
exists to remove, and it is worth one rule-id.

### 3.6 Explicit non-goal: per-package policy

`analyzers` is **repo-global**, not per-workspace-package, consistent with every
other field in `RepoConfig`. Per-package analyzer policy in a monorepo is a
coherent future feature and is not this phase.

## 4. Piece 2 — honoring `enforcement`

`RepoConfig.enforcement: 'warn' | 'block'` has existed since Phase A and is
consumed by nothing; `gate --mode=commit` and `gate --mode=pretooluse` both
hard-block unconditionally. Honoring it was explicitly reserved for this phase.

**Scope: the commit and preToolUse gates, plus CI by consequence. Not the Stop
loop.** `config.ts` documents that decision deliberately and it stands: the Stop
loop is the flagship local feature, its safety comes from the bounded attempt
counter rather than from this flag, and a `warn`-mode repo with no delegation
loop has switched off the feature rather than softened it. `toGateConfig`
continues not to forward `enforcement`.

**Enforcement lives entirely in the CLI's exit code.** No template, workflow, or
hook definition encodes it, so config and wiring cannot skew:

- `gateCommitCommand` returns `1` only when `blocked && enforcement === 'block'`.
  Under `warn` it still prints every violation and finding, followed by an
  explicit `not blocking (enforcement: warn)` line — a passing exit code must
  never be mistakable for a clean gate.
- `gatePreToolUseCommand` under `warn` emits the non-blocking feedback shape
  instead of a deny.
- The scaffolded CI step simply runs the gate; its exit code already carries the
  policy. No `continue-on-error`, and no re-rendering a workflow when config
  changes.

## 5. Piece 3 — packaging and release

### 5.1 Delivery decision: npm-only

The Claude Code plugin has never had a delivery story: the npm package ships
`files: ["dist", "guidance"]`, and the hooks and fixer agents live in
`guardrails-plugin/`, which a consumer has no way to obtain.

**The npm tarball becomes the only delivery vehicle.** It carries the hook
definitions, both fixer agents, the pre-commit hook, the CI workflow, and the
guidance docs as generated templates; `guardrails init` writes them into the
consumer repo. Rationale:

- This repo already proves the inline path — it self-hosts by wiring `.claude/`
  directly, not through the plugin.
- Copilot has no plugin mechanism at all, so file-writing is required for parity
  regardless. Writing the Claude Code files too costs nothing extra.
- Idempotency and upgrade need a version marker and per-file ownership, which is
  only tractable when one component owns the writes.
- One install channel means one getting-started document rather than a fork by
  runtime.

`guardrails-plugin/` remains the build-time single source of truth, unchanged.
A marketplace channel is not built and not precluded.

### 5.2 Templates are generated, never authored twice

`scripts/sync-agents.mjs` already emits the fixer agents into two formats from
`guardrails-plugin/`. It gains a third destination, `guardrails-core/templates/`,
which is added to `files`. CLAUDE.md's one-source-of-truth rule holds, and CI's
existing `git diff --exit-code` drift-guard extends to cover the new output.

### 5.3 Release mechanics

- `guardrails-core` version `0.0.0` → **`0.1.0`**.
- `files: ["dist", "guidance", "templates"]`.
- `.github/workflows/release.yml`: on tag `v*`, build, `npm pack`, and attach the
  tarball to a GitHub Release. `permissions: contents: write` scoped to that job
  alone.
- Install line:
  `npm i -D https://github.com/ddteeter/agentic-guardrails-scaffolding/releases/download/v0.1.0/guardrails-core-0.1.0.tgz`

**The tarball smoke test is the load-bearing part.** CI runs `npm pack`, installs
the resulting tarball into a temporary fixture repo, and runs
`guardrails init --plan`. It is the only test that can catch a missing `files`
entry, a broken bin shebang, or an ESM resolution failure — exactly the class of
bug a workspace symlink hides today, and exactly the class that makes a first
adoption fail at the first command.

Migration to npm later swaps the pack/release step for
`npm publish --provenance` and changes nothing else. The name `guardrails-core`
is unclaimed on the public registry (verified 2026-08-30).

**Stated cost, to be documented rather than discovered:** a URL dependency has no
semver range, no dedupe, and no Dependabot tracking. Upgrades are a manual URL
edit.

## 6. Piece 4 — `guardrails init`

### 6.1 Why a CLI command and not a skill

plan.md specifies the scaffolder as a Claude Code _skill_. That is a
Claude-only design, and Phase B made Copilot a first-class surface across VS
Code, CLI, and cloud agent; a Claude-only scaffolder is a regression. The CLI is
also the only form that works in CI and in a headless agent.

The skill is not discarded — it becomes the **judgement layer above** the CLI
(§8). The CLI owns detection, the plan, and the writes: everything that must be
deterministic and idempotent. The skill owns the decisions.

### 6.2 Invocation modes

- `guardrails init` — interactive prompts when stdin is a TTY; otherwise
  identical to `--plan`. It never writes by accident.
- `guardrails init --plan [--json]` — writes nothing; emits the detection result
  and the intended actions. The JSON form is what the skill consumes.
- `guardrails init --apply [--analyzers=…] [--enforcement=…] [--distribution=…] [--force]`
  — writes.

### 6.3 Detection inputs

`package.json` (dependencies, `workspaces`, `engines`), presence of
`tsconfig.json` / an eslint config / each analyzer's config, the git toplevel and
base branch, existing `.claude/` `.github/` `.husky/` and `core.hooksPath`
settings, and any existing `guardrails.config.json` plus scaffold manifest.

### 6.4 The three file classes

**OWNED** — checksum-tracked in a committed `.guardrails/scaffold.json`.
Unmodified → rewritten on upgrade. Modified → left alone and reported as drift.
`--force` overwrites.

- `.claude/agents/guardrail-fixer.md`, `.claude/agents/guardrail-fixer-thorough.md`
- `.github/agents/guardrail-fixer.agent.md`, `.github/agents/guardrail-fixer-thorough.agent.md`
- `.github/hooks/guardrails.json`
- `.githooks/pre-commit`
- `.github/workflows/guardrails.yml`
- `.claude/skills/*/SKILL.md` and `docs/guardrails/*.md` — **run-time**
  guidance only (`crushing-mutants`, the boundary-validator doc). The
  `adopting-guardrails` skill is deliberately excluded; it is adoption-time
  and ships in the tarball instead (§8.1).

**SHARED** — merge only guardrails' own entries; consumer content untouched.

- `.claude/settings.json` — guardrails hook entries are identified by their
  command string containing `guardrails-core/dist/cli.mjs`. Stale guardrails
  entries are removed, foreign entries preserved.
- `.github/copilot-instructions.md` — the existing
  `<!-- guardrails:skills:start/end -->` marker block, reusing `sync-agents.mjs`'s
  logic.
- `.gitignore` — a marker-delimited block (`.guardrails/state/`,
  `reports/mutation/`, `.stryker-tmp/`). **Not** `.claude/agents/` or
  `.claude/skills/`: this repo ignores those because it _generates_ them on
  every build, but a consumer has no build step and must commit them — the
  Copilot cloud agent and any teammate read them from the default branch.
  Copying this repo's `.gitignore` into a consumer would silently disable
  the fixer agents there.
- `package.json` — `scripts.prepare` only (§6.6).

**SEED-ONCE** — created if absent, never touched again.

- `guardrails.config.json`
- `.dependency-cruiser.cjs` and `stryker.conf.json`, only when those analyzers
  are enabled and no config already exists. Both tools are unusable without a
  config, so enabling them otherwise guarantees `analyzer-failed` on day one.
  `init` deliberately never writes `eslint.config.js` or `tsconfig.json` — every
  real TypeScript project has its own, and guardrails-core should not take on
  maintaining lint opinions for other people's repositories.

### 6.5 The scaffold manifest

`.guardrails/scaffold.json`, **committed**:

```json
{
  "guardrailsVersion": "0.1.0",
  "files": { ".githooks/pre-commit": "sha256-…" }
}
```

No timestamp field: deterministic output keeps the file out of every diff and
lets a CI drift-check work on it. It sits alongside — not inside — the gitignored
`.guardrails/state/`, so it is committed while state stays ephemeral.

### 6.6 Activating the git hook

`.githooks/pre-commit` does nothing until `core.hooksPath` is set, which is
per-clone local config and cannot be checked in. `--apply` therefore does both:
sets it locally, and appends to `scripts.prepare` in `package.json`
(`… && guardrails install-hooks`), the trick husky uses, so teammates get it on
`npm install`.

This implies one small new subcommand, **`guardrails install-hooks`**. Merging
rather than replacing an existing `prepare` is load-bearing: a consumer already
running husky would otherwise lose it silently.

### 6.7 Guidance docs are copied in, not linked into `node_modules`

Phase C's CI comment reasons that `guardrails-core/guidance/` ships in the
tarball so guidance "resolves via node_modules in a consumer repo, where
docs/guardrails does not exist." **That reasoning does not survive contact with
the Copilot cloud agent, which reads from the default branch**, where
`node_modules` is not committed.

So `init` copies run-time guidance into `docs/guardrails/` as OWNED files. The
packaged `guidance/` directory stays — it is the source `init` copies _from_, and
it is what makes adoption-time guidance readable before adoption (§8).

### 6.8 Rider: `resolveRepoRoot`

`init` must resolve the git toplevel to write anything correctly. The roadmap
already carries an unfixed bug with the same root: there is no git-root
resolution anywhere in `src`, so `stateDirectory(repoRoot)` resolves against
`cwd` and `recurrence.json` **fragments and undercounts** when the CLI is run
from a subdirectory. It also lets nested `.guardrails/` directories escape the
root-anchored `.gitignore` pattern.

That bug is invisible in this repo and certain to bite a real adopter running
`guardrails verify` from a package directory. A `resolveRepoRoot(exec, cwd)` seam
(`git rev-parse --show-toplevel`, through the injected `exec`, with a fake exec in
tests) lands as part of this piece, and the broader gitignore-hygiene follow-up
is subsumed by it.

## 7. Piece 5 — the adoption dry-run checkpoint

After pieces 1–3, adopt guardrails into the real greenfield repo **by hand**:
install the release tarball, hand-author `guardrails.config.json` including the
`analyzers` block, copy the hook and agent files, wire `core.hooksPath`, and run
the loop until `guardrails verify` is green.

The output is not code. It is a list of findings recorded in `plan.md`, answering:
what did the footprint actually have to contain, what was ambiguous, what
defaults were wrong, and what did the manual path require that §6.4's file list
does not cover. Piece 4 is revised against that list before it is finished.

## 8. Piece 6 — the scaffolding skill (judgement layer)

Source at `guardrails-plugin/skills/adopting-guardrails/`, riding the pipeline
Phase C built: `sync-agents.mjs` emits it to `.claude/skills/`, `docs/guardrails/`,
`guardrails-core/guidance/`, and indexes it in `.github/copilot-instructions.md`.
One source, three surfaces — Claude Code skill, Copilot doc plus index, and
`guardrails init` interactive for a plain CLI user.

### 8.1 The bootstrapping split

A skill that explains how to adopt guardrails cannot itself be delivered by
adoption. The resolution also settles what `init` installs:

- **Adoption-time guidance ships in the tarball.** After
  `npm i -D guardrails-core`, the skill is readable at
  `node_modules/guardrails-core/guidance/adopting-guardrails.md`. It is a
  one-time task and never needs to live in the consumer repo.
- **Run-time guidance is installed into the repo** by `init` —
  `crushing-mutants`, the boundary-validator doc — because those are needed
  every day, by the cloud agent, from the default branch.

### 8.2 What the skill does

1. Run `guardrails init --plan --json`.
2. Read the repo for real: library vs application vs monorepo, which analyzers
   already have configs, what `CLAUDE.md` / `AGENTS.md` /
   `copilot-instructions.md` say.
3. Propose an analyzer set **with reasoning**, and an `enforcement` starting
   point.
4. Ask the user about the genuine judgement calls — with specifics, not a
   generic prompt.
5. Author or tune the configs the CLI deliberately does not own: an eslint flat
   config if absent, dependency-cruiser rules beyond the starter, stryker's
   test-runner plugin and thresholds.
6. Run `guardrails init --apply` with the decisions.
7. **Run `guardrails verify` and iterate until it is green.**

Step 7 is the exit criterion. Not "files written" — green. The README's
clean-baseline prerequisite means a repo scaffolded onto a dirty baseline has a
gate that blocks every turn on pre-existing findings, which is worse than no
gate. Scaffolding ends at file-writing; **adoption ends at green.**

### 8.3 Boundary-validator guidance

A second doc on the same pipeline, delivering the Phase C redirect: at trust
boundaries, `schema.parse(JSON.parse(x))` rather than a structural cast; and the
fixer's instruction for a boundary cast becomes _route it to a validator_, not
_delete it_. Referenced from both fixer agents. No dependency is installed and no
validator is chosen for the consumer — that is step 5's call, per repo.

## 9. Piece 7 — CI template, docs, team flip

### 9.1 CI template

`.github/workflows/guardrails.yml`, consumer-generic: checkout with
`fetch-depth: 0` (the merge-base baseline needs history) and
`persist-credentials: false`, setup-node, `npm ci`, then:

```
guardrails gate --mode=commit
guardrails sanctions-check
```

The first line is the item-3 fix. **CI never runs the diff-auditor today** — it
runs bare `verify`. `gate --mode=commit` already runs verify _plus_ the
diff-auditor _plus_ the sanction budget, so the gap closes by calling the right
command rather than by new code. This repo's own `ci.yml` adopts the same shape.

**Recorded seam, not built:** `--mode=commit` verifies at `profile: 'commit'`,
and no analyzer currently declares `minRung: 'ci'`, so commit ≡ ci today. The day
one does, CI needs a `--mode=ci`.

### 9.2 Adoption docs

`docs/adoption.md`, linked from the README: install, `init`, what each written
file is and who owns it, what each analyzer costs at which rung, the
clean-baseline prerequisite, starting in `warn` and graduating to `block`,
re-running `init` after an upgrade and reading a drift report, the URL-dependency
upgrade caveat, the kill-switch, and the note that an org admin can disable the
Copilot CLI or cloud-agent surface outright, leaving that half inert.

### 9.3 Team-flip verification

plan.md has asserted since Phase A that solo→team is "config plus a publish, not
a rewrite". This piece **tests that claim** rather than restating it.

Prediction, recorded so it can be falsified: `enforcement: block` +
`distribution: team` + a required CI check is genuinely config-only, but
_committing `recurrence.json`_ is probably not. The ledger lives under
`.guardrails/state/`, which is gitignored and swept on a 7-day TTL, so a
committed ledger would be both ignored and eventually deleted. If that holds, the
claim is **false as written** and the flip needs a small change: move the ledger
out of `state/`, or exempt it from both the ignore and the sweep. The piece
confirms or fixes it, and updates plan.md either way.

## 10. Testing

Following the seams the codebase already uses — `exec`, `readFile` and
`removeFile` are all injected.

- **Opt-in:** table-driven across all six truth-table rows (§3.3) per analyzer,
  with a fake exec; plus the `analyzer-unknown` warn case and the `false`
  never-spawned case.
- **Enforcement:** both gates under both values, asserting the exit code **and**
  that violations are still printed under `warn`.
- **init:** a filesystem seam, then per-class tests — OWNED unmodified →
  rewritten; OWNED modified → skipped and reported; OWNED modified with
  `--force` → overwritten; SHARED merge preserves foreign entries; SEED-ONCE
  never re-touched. Plus a full idempotency test: apply twice, assert a
  byte-identical tree and an empty second-run action list.
- **`resolveRepoRoot`:** fake exec returning a toplevel above `cwd`; assert state
  and manifest paths anchor there.
- **Tarball smoke test:** the one test that deliberately uses no seams (§5.3).
- **Drift-guard:** extended to `guardrails-core/templates/`.

## 11. Risks and open items

1. **The mutation gate versus a large new module.** Piece 4 is the biggest new
   surface this project has added, and this repo gates `stryker/survived` at zero
   tolerance on changed production files. `init` is string, path and merge logic
   — mutation-dense, exactly like `audit.ts`, which is where the coarse-suppression
   debt came from. Expect piece 4 to cost well beyond what its logic suggests,
   and expect pressure toward sanctions. **Mitigation is structural:** keep plan
   _computation_ pure and separate from file _I/O_, so mutants die to unit tests
   rather than to integration tests. Per CLAUDE.md, no `sanctionedSuppressions`
   entry is added without asking first.
2. **The dry-run may invalidate piece 4's design.** That is what piece 5 is for,
   but it means piece 4 reaches the checkpoint reviewable and revisable rather
   than polished.
3. **`.claude/settings.json` is the sharpest edge.** It is the one SHARED file
   where a wrong merge either silently disables the loop or clobbers a consumer's
   own hooks. It gets the most test attention.
4. **The Copilot half may be inert in a managed org.** plan.md records that
   admins can disable the CLI or cloud-agent surface outright. `init` writes the
   files regardless; §9.2 documents the consequence.
5. **Open:** the `--mode=ci` seam (§9.1) is recorded, not built.
