---
name: adopting-guardrails
description: Use when installing guardrails-core into a repo — about to run `guardrails init`, or asked to set up, configure, or scaffold the guardrail loop for a project. Covers reading the CLI's plan before acting on it, proposing an analyzer set and enforcement level with reasoning, authoring the configs `init` deliberately does not own, and the real exit criterion — a green `guardrails verify`, not files written to disk.
---

# Adopting guardrails

`guardrails init` is deterministic on purpose: it detects what the repo already
has, decides what to write, and writes it. It does not decide **whether any of
that is right for this repo** — which analyzers earn their cost, how strict to
start, or what a dependency-cruiser rule set should actually forbid. Those are
judgement calls, and `init` is not built to make them; it is built to be driven
by something that can. That something is this document.

## The bootstrapping split

A skill that explains how to adopt guardrails cannot itself be delivered by
`init` — the reader hasn't run it yet. So the split runs the other way:

- **Adoption-time guidance ships in the tarball.** The moment
  `npm i -D guardrails-core` finishes, this document is readable at
  `node_modules/guardrails-core/guidance/adopting-guardrails.md`, before a
  single file has been scaffolded. It is a one-time read; it never needs to
  live in the consumer repo, and `init` does not copy it there.
- **Run-time guidance is installed into the repo by `init`.** `crushing-mutants`
  and the boundary-validation doc land under `docs/guardrails/` **and** as
  `.claude/skills/<name>/SKILL.md`, because they are needed every day, by the
  cloud agent reading from the default branch, where `node_modules` does not
  exist.

If you're reading this from `.claude/skills/` or `docs/guardrails/` inside
**this** repo (guardrails-core's own development home), that's normal — this
repo dogfoods its own output, so every skill it ships to consumers is also
synced into its own tree for self-hosting. A consumer repo won't have this file
locally; they'll have read it from the tarball once, before scaffolding.

## The seven steps

### 1. Run `guardrails init --plan --json`

Not a guess about the repo — the CLI already did the detection. `--plan` writes
nothing; `--json` gives you `repoRoot`, `baseBranch`, the list of file actions
`init` intends to take (`kind`, `path`, `reason` for each), and any warnings.
Read this before forming an opinion about what the repo needs. If a config
`init` would seed already exists, the plan says so — don't propose overwriting
it.

### 2. Read the repo for real

The plan tells you what `init` will write. It does not tell you what kind of
repo this is. Read for yourself: library, application, or monorepo; which
analyzer configs already exist versus which are absent; what `CLAUDE.md`,
`AGENTS.md`, or `copilot-instructions.md` already say about how this team
works. A monorepo's dependency-cruiser rules look nothing like a single
package's; a library that ships types cares about `tsc` in a way an internal
CLI tool doesn't.

### 3. Propose an analyzer set, with reasoning — not a menu

`guardrails.config.json`'s `analyzers` block has three states per tool:
`false` (off), `"auto"` (runs if installed, errors if declared-but-missing),
`"required"` (errors if it can't run at all). Give the user a **recommendation**
they can override, not an open questionnaire:

- `eslint` and `tsc` run at the `stop` rung — every turn, cheap, foundational.
  Default them `required`; a repo that can't lint or type-check itself has no
  gate worth having.
- `knip`, `dependency-cruiser`, and `stryker` run at the `commit` rung —
  heavier, and each has a real precondition. `knip` and `dependency-cruiser`
  need a whole-repo clean baseline before they can gate anything (step 7).
  `stryker` needs a test suite worth mutating; recommending it for a repo with
  thin coverage just produces noise, and mutation testing is genuinely slow —
  say so.
- Default `enforcement: warn` for a first adoption. `block` before the team has
  seen what the gate finds turns the first week into a fire drill instead of a
  calibration.

State the reasoning in terms of _this_ repo's facts from step 2, not the
general case.

### 4. Ask about the judgement calls that are actually genuine

Only the ones step 1–3 couldn't settle from evidence: solo vs. team
distribution (changes the enforcement default and whether CI is required),
which test runner Stryker should target once the starter `command` runner
isn't good enough, and which validator library (§5) fits the repo's existing
dependency graph. Ask with the specific fork in front of you — "this repo has
no test-runner-specific Stryker plugin installed; do you want `@stryker-mutator/vitest-runner`
or stay on the generic `command` runner" — not "how do you want mutation
testing configured?"

### 5. Author the configs and dependencies `init` deliberately does not own

`init` seeds three configs only when their analyzer is enabled and no config
exists (SEED-ONCE): a starter `.dependency-cruiser.cjs` (one rule —
`no-circular`) and a starter `stryker.conf.json` (`testRunner: "command"`, no
thresholds). It never touches them again, and it **never writes
`eslint.config.js` or `tsconfig.json` at all** — those don't exist for it to
seed. This is deliberate, not a gap: every real TypeScript project already has
its own lint and compiler opinions, and guardrails-core has no business
maintaining lint rules for somebody else's repository. That's this step's job:

- **`eslint.config.js`**, if the repo has none — the flat config, matching the
  repo's actual code (React vs. Node, CJS vs. ESM), not a copy of this repo's
  house rules.
- **Dependency-cruiser rules beyond `no-circular`** — layer boundaries specific
  to this repo's module graph (e.g. `src/` can't import `test/`, `core/` can't
  import `adapters/`).
- **Stryker's test-runner plugin and thresholds** — swap `command` for a
  framework-specific runner once one is installed, and set `break`/`low`/`high`
  thresholds that mean something, not the schema's defaults.
- **A validator library, if a boundary cast needs redirecting** (see the
  `boundary-validation` skill) — zod, valibot, typia, or arktype, whichever
  matches the repo's existing dependency graph and the team's taste.
  `guardrails-core` installs none and picks none: this is the same kind of
  per-repo call as the eslint config above, just for a dependency instead of
  a file.

### 6. Run `guardrails init --apply` with the decisions

Now write the files, with the analyzer set, enforcement level, and distribution
decided in steps 3–4 passed as flags.

### 7. Run `guardrails verify` and iterate until it is green

**This is the exit criterion. Not "files written" — green.** `knip` and
`dependency-cruiser` are whole-graph, clean-baseline analyzers, same as `tsc`:
they don't diff-scope, so every pre-existing issue in the repo shows up on the
very first run. A repo scaffolded onto a dirty baseline gets a gate that blocks
every future turn on findings nobody just introduced — which is worse than no
gate at all, because it teaches the team to route around it.

**Scaffolding ends at file-writing; adoption ends at green.** Don't stop at
step 6. Fix or triage every finding `verify` reports before calling the
adoption done — that's the actual deliverable, not the presence of a
`guardrails.config.json`.
