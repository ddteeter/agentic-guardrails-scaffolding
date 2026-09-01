# Phase E pieces 5–6 — the scaffolding skill, CI template, adoption docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the consumer-facing surface. `guardrails init` writes files;
these two pieces give a consumer the judgement layer that decides _what_ to write,
the CI that enforces it, and the documentation that explains it.

**Architecture:** Pieces 5 and 6 share one plan because they interlock: the CI
workflow piece 6 introduces is delivered by the template pipeline piece 5 extends,
and both land in the same pull request. Piece 5 is the skill — authored once under
`guardrails-plugin/skills/` and emitted by `scripts/sync-agents.mjs` to a Claude
Code skill, a Copilot doc, and the packaged `guidance/` tree. Piece 6 is the CI
template, the adoption document, and a verification of a claim `plan.md` has been
making since Phase A.

**Tech Stack:** Node ≥24 ESM, Vitest, GitHub Actions, Markdown.

**Spec:** `docs/superpowers/specs/2026-08-30-phase-e-adoption-design.md` §7 and §8

## Global Constraints

- **`guardrails-core` has zero runtime dependencies.** Do not add one.
- **TDD** wherever there is logic. Several tasks here are prose or YAML, verified
  by running rather than by unit tests — each task says which it is.
- **Never weaken a gate to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Never add a `sanctionedSuppressions` entry or a `// Stryker disable`
  directive, and never edit `stryker.conf.json`.** The config has exactly 27
  entries and must still have 27. If a mutant survives and you believe it
  equivalent, STOP and report — in this phase that situation arose four times and
  was resolved every time by restructuring or a real test, never by an exemption.
- TypeScript strictness is `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`.
- **House lint rejects** abbreviations (`dir` → `directory`), unused parameters,
  and a bare `.sort()` (`sonarjs/no-alphabetical-sort`).
- Prefix every command with `mise exec --`. The shell default is Node 25;
  dependency-cruiser refuses it and the commit gate fails confusingly.
- **Prose must match the repo's voice:** dense, specific, stating costs alongside
  capabilities. No marketing language. Accuracy over completeness — a doc that
  overstates what shipped is worse than one that says less.
- Commit in small logical steps.

---

## What already exists, and what these pieces add

`scripts/sync-agents.mjs` already emits, from `guardrails-plugin/skills/<name>/SKILL.md`:

- `.claude/skills/<name>/` — this repo's own Claude Code skills (gitignored, regenerated)
- `docs/guardrails/<name>.md` — committed, human-readable
- `guardrails-core/guidance/<name>.md` — committed, ships in the tarball
- a marker-delimited index block in `.github/copilot-instructions.md`

`guardrails init` installs run-time guidance into a consumer's `docs/guardrails/`
but **cannot yet write the Copilot index**, because the index needs each doc's
one-line trigger description and `parseSkill` strips the frontmatter before
writing `guidance/`. Task 3 closes that.

---

## Task 1: The `adopting-guardrails` skill

**Files:**

- Create: `guardrails-plugin/skills/adopting-guardrails/SKILL.md`

**Interfaces:**

- Consumes: nothing.
- Produces: a skill emitted by `sync-agents.mjs` to all four destinations.

This is the judgement layer above the CLI. `init` owns detection, the plan, and
the writes — everything that must be deterministic. The skill owns the decisions.

Spec §7.2 gives seven steps. Write them as the skill's body, in the repo's skill
voice (read `guardrails-plugin/skills/crushing-mutants/SKILL.md` first and match
it — it is dense, imperative, and explains why each step matters).

The frontmatter needs `name` and `description`. The description is what appears
in the Copilot index and is a _trigger_, not a summary: it must say **when** to
read this, not what it contains. Match the shape of `crushing-mutants`'s.

The body must carry these, and they are the substance:

- **Step 1 is `guardrails init --plan --json`**, not a guess about the repo.
- **Step 3 proposes an analyzer set with reasoning**, and an `enforcement`
  starting point. Not a menu — a recommendation the user can override.
- **Step 5 authors the configs the CLI deliberately does not own**: an eslint
  flat config if absent, dependency-cruiser rules beyond the starter, stryker's
  test-runner plugin and thresholds. `init` never writes `eslint.config.js` or
  `tsconfig.json`, and the skill must say why: every real TypeScript project has
  its own, and guardrails-core should not maintain lint opinions for other
  people's repositories.
- **Step 7 is the exit criterion, and it is not "files written".** It is
  `guardrails verify` green. A repo scaffolded onto a dirty baseline has a gate
  that blocks every turn on pre-existing findings, which is worse than no gate.
  State it as: _scaffolding ends at file-writing; adoption ends at green._

Also state the bootstrapping split (§7.1) so a reader knows where this document
lives: adoption-time guidance ships in the tarball and is readable at
`node_modules/guardrails-core/guidance/adopting-guardrails.md` before anything is
scaffolded; run-time guidance is installed into the repo by `init`.

- [ ] **Step 1: Read the existing skill for voice**

Read `guardrails-plugin/skills/crushing-mutants/SKILL.md` end to end.

- [ ] **Step 2: Write the skill**

- [ ] **Step 3: Build and check every destination**

Run: `mise exec -- npm run build`
Then confirm the skill appears in all four places:

```bash
ls .claude/skills/adopting-guardrails/
ls docs/guardrails/adopting-guardrails.md guardrails-core/guidance/adopting-guardrails.md
grep -n 'adopting-guardrails' .github/copilot-instructions.md
```

- [ ] **Step 4: Commit**

```bash
mise exec -- git add guardrails-plugin/skills/adopting-guardrails docs/guardrails guardrails-core/guidance .github/copilot-instructions.md
mise exec -- git commit -m "feat(skill): adopting-guardrails, the judgement layer above init"
```

---

## Task 2: The boundary-validation guidance

**Files:**

- Create: `guardrails-plugin/skills/boundary-validation/SKILL.md`
- Modify: `guardrails-plugin/agents/guardrail-fixer.md`, `guardrails-plugin/agents/guardrail-fixer-thorough.md`

**Interfaces:**

- Produces: a second guidance doc on the same pipeline, referenced by both fixers.

Spec §7.3, delivering the Phase C redirect. Phase C investigated making
unvalidated-cast-at-a-trust-boundary a lint gate and concluded there is no
reliable-**and**-complete lint for it: `@typescript-eslint/no-unsafe-type-assertion`
cannot distinguish "cast then validate" from "cast and trust", and narrowing it to
the syntactic `JSON.parse(x) as T` form trades false positives for false
negatives. The by-construction fix is a runtime validator, which produces no cast
to detect. See `docs/superpowers/specs/2026-07-21-phase-c-boundary-cast-rule-design.md`.

The doc must say:

- At a trust boundary — disk JSON, network, environment, external tool output —
  prefer `schema.parse(JSON.parse(x))` over a structural cast.
- **The fixer's instruction for a boundary cast is to route it to a validator,
  not to delete the code.** That is the redirect; state it plainly.
- **No validator is installed and none is chosen for the consumer.** Picking zod
  vs valibot vs typia is the adopting skill's step-5 call, per repo.
- The diff-auditor's existing `as any` / `as unknown as` rejection stays — that
  pattern _is_ reliably detectable, because it is the explicit escape hatch
  rather than the laundering cast.

Then add a reference to it from both fixer agents, in the section where they are
told what to do with a violation they cannot mechanically fix. Keep it to a
sentence and a path; the fixers' prompts are already long and their context is
the scarce resource.

- [ ] **Step 1: Write the guidance**
- [ ] **Step 2: Reference it from both fixer agents**
- [ ] **Step 3: Build; confirm `.github/agents/*.agent.md` regenerated and committed**

`CLAUDE.md` is explicit: `.github/agents/` is generated but **committed**, and CI
guards drift with `git diff --exit-code`. Never hand-edit it — edit
`guardrails-plugin/agents/`, rebuild, and commit the regenerated output alongside.

- [ ] **Step 4: Commit**

---

## Task 3: Ship descriptions in `guidance/` so `init` can write the Copilot index

**Files:**

- Modify: `scripts/sync-agents.mjs`
- Modify: `guardrails-core/src/scaffold/templates.ts`
- Modify: `.github/workflows/ci.yml` (drift-guard path)
- Test: `guardrails-core/test/scaffold/templates.test.ts`

**Interfaces:**

- Produces: `guardrails-core/guidance/index.json` — `{ "<name>": "<description>" }`
- Produces: a `.github/copilot-instructions.md` entry in `init`'s `desired` map.

This is the carried follow-up from piece 4, and `plan.md` records the fix
direction: **ship the descriptions alongside the bodies in `guidance/`, plus one
drift-guard line — not extend `sync-agents.mjs` wholesale.**

Today `parseSkill` reads each skill's frontmatter, uses the description to build
the `.github/copilot-instructions.md` index for _this_ repo, then writes only the
body to `guidance/`. So a consumer's installed `docs/guardrails/*.md` land with
nothing referencing them, because `init` has no trigger text to build an index
from.

- [ ] **Step 1: Emit the index**

In `scripts/sync-agents.mjs`, alongside the existing per-skill writes, emit
`guardrails-core/guidance/index.json` mapping each skill name to its description.
Deterministic: sorted keys, two-space indent, trailing newline — the same
discipline `serializeManifest` uses, so the committed file stays out of every
diff and the drift-guard works on it.

- [ ] **Step 2: Extend the CI drift-guard**

Add nothing new to the path list — `guardrails-core/guidance` is already covered
by the `Skill docs in sync` step, and `index.json` lives inside it. **Verify that
is true** rather than assuming; if the step lists individual files rather than the
directory, add the path.

- [ ] **Step 3: Write the failing test**

In `guardrails-core/test/scaffold/templates.test.ts`, assert that
`buildDesiredFiles` now includes `.github/copilot-instructions.md`, and that its
content contains both the marker block and at least one skill's trigger text
(not merely a link). A bare-links index is the failure this task exists to avoid,
so assert the description is present.

- [ ] **Step 4: Build the index block in `templates.ts`**

Read `guidance/index.json` from the packaged tree and construct the marker block
using the same dialect `mergeCopilotInstructions` expects. Do not invent a second
format — `merge.ts` already owns the splice.

Remove the comment block in `templates.ts` that explains why
`.github/copilot-instructions.md` is deliberately absent; it is no longer true.
Leave the two entries that remain deliberate (`.github/workflows/guardrails.yml`
until Task 5, `.claude/skills/*/SKILL.md`) accurate.

- [ ] **Step 5: Verify, mutation-check, commit**

Run the full suite, lint, typecheck, and
`mise exec -- npx stryker run --mutate guardrails-core/src/scaffold/templates.ts`.
0 survived, 0 no-coverage.

---

## Task 4: `init` installs the adopting skill's run-time siblings

**Files:**

- Modify: `guardrails-core/src/scaffold/templates.ts`
- Test: `guardrails-core/test/scaffold/templates.test.ts`

Spec §6.4 lists `.claude/skills/*/SKILL.md` as OWNED, and §7.1 draws the line:
**run-time** guidance is installed into the consumer repo; **adoption-time**
guidance ships in the tarball and is never installed.

So `init` must install `crushing-mutants` and `boundary-validation` as
`.claude/skills/<name>/SKILL.md`, and must **not** install `adopting-guardrails`.

- [ ] **Step 1: Write the failing test**

Assert `buildDesiredFiles` includes `.claude/skills/crushing-mutants/SKILL.md`
and `.claude/skills/boundary-validation/SKILL.md`, and explicitly assert it does
**not** include `.claude/skills/adopting-guardrails/SKILL.md`. That negative
assertion is the point of the bootstrapping split — write it as its own `it` with
a comment saying why.

- [ ] **Step 2: Implement**

The packaged `guidance/` tree is the source. Exclude `adopting-guardrails` by
name, and state the reason in a comment at the exclusion so a future reader does
not "fix" it.

- [ ] **Step 3: Verify, mutation-check, commit**

---

## Task 5: The consumer CI workflow template

**Files:**

- Create: `guardrails-plugin/templates/workflows/guardrails.yml`
- Modify: `scripts/sync-agents.mjs`, `guardrails-core/src/scaffold/templates.ts`
- Test: `guardrails-core/test/templates.test.ts`, `guardrails-core/test/scaffold/templates.test.ts`

Piece 3 deliberately deferred this: the machinery to ship a template exists and
needs no change, only the content. Spec §8.1 gives it.

The workflow, consumer-generic:

```yaml
name: Guardrails

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  guardrails:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The commit gate diffs against the merge-base, which needs history.
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      # `gate --mode=commit` runs verify PLUS the diff-auditor PLUS the sanction
      # budget. Bare `verify` runs none of the last two.
      - run: npx guardrails gate --mode=commit
      - run: npx guardrails sanctions-check
```

Two notes to carry into the file as comments:

- A consumer's workflow should use floating major tags (`@v4`), not the pinned
  SHAs this repo uses internally — a consumer has their own Dependabot policy and
  a pinned SHA in a scaffolded file would rot silently in their repo.
- Record the seam spec §8.1 names: `--mode=commit` verifies at `profile: 'commit'`,
  and no analyzer declares `minRung: 'ci'`, so commit ≡ ci today. The day one
  does, CI needs a `--mode=ci`.

- [ ] **Step 1: Write the template** at `guardrails-plugin/templates/workflows/guardrails.yml`
- [ ] **Step 2: Emit it** into `guardrails-core/templates/workflows/` from `sync-agents.mjs`
- [ ] **Step 3: Assert it** in `guardrails-core/test/templates.test.ts`'s `EXPECTED_FILES`
- [ ] **Step 4: Add it** to `buildDesiredFiles` as an OWNED path, with a test
- [ ] **Step 5: Verify and commit**

Confirm `mise exec -- npm run smoke:tarball` still passes — the tarball now has a
new directory and the smoke test's `templates/` assertions must still hold.

---

## Task 6: This repo's own CI adopts the same shape

**Files:**

- Modify: `.github/workflows/ci.yml`

Spec §8.1: _"This repo's own `ci.yml` adopts the same shape."_ Today it runs bare
`verify`, so **CI never runs the diff-auditor** — a suppression added on a branch
is caught by the commit gate locally but not by CI.

- [ ] **Step 1: Replace the `Guardrails verify` step**

Change it to `gate --mode=commit`. Keep the existing `sanctions-check` step and
its long explanatory comment — that comment is load-bearing and still accurate.

Update the step's name and add a sentence to its comment explaining that
`gate --mode=commit` runs verify plus the diff-auditor plus the sanction budget,
which bare `verify` does not.

- [ ] **Step 2: Verify locally**

Run `mise exec -- node guardrails-core/dist/cli.mjs gate --mode=commit` and
confirm it exits 0 on a clean tree. If it does not, **stop and report** — that
would mean this branch has a finding CI would have caught, which is exactly what
this change exists to surface.

- [ ] **Step 3: Commit**

---

## Task 7: The adoption document

**Files:**

- Create: `docs/adoption.md`
- Modify: `README.md` (link it)

Spec §8.2. This is the document a real adopter reads. It must cover, each with
its cost stated:

- Install (the Release tarball URL, and that no `v0.1.0` exists until a tag is pushed)
- `init --plan` then `init --apply`; what re-running does
- **What each written file is and who owns it** — the three classes, in a table:
  OWNED (upgraded when unmodified, drift-reported when edited, `--force`
  overwrites), SHARED (merged, consumer content untouched), SEED-ONCE (created
  once, never overwritten, `--force` included)
- **What each analyzer costs at which rung** — eslint/tsc every turn;
  knip/dependency-cruiser/stryker at commit and CI only
- **The clean-baseline prerequisite** — `verify` must be green before the gate is
  useful, because whole-project analyzers report pre-existing findings on every turn
- **Starting in `warn` and graduating to `block`** — and that the Stop loop is
  never softened by `enforcement`
- Re-running `init` after an upgrade and reading a drift report
- The URL-dependency caveat: no semver range, no dedupe, no Dependabot tracking
- The kill-switch (comment out the `Stop` hook; the pre-push gate and CI remain)
- That an org admin can disable the Copilot CLI or cloud-agent surface outright,
  leaving that half inert

Also carry the three known limits `plan.md` records, in one short section — a
consumer should learn about the settings.json reformatting and the orphan-file
behaviour from the adoption doc, not by hitting them.

- [ ] **Step 1: Write it, verifying every claim against the code**
- [ ] **Step 2: Link from `README.md`**
- [ ] **Step 3: `mise exec -- npm run format:check`, then commit**

---

## Task 8: Verify the solo→team claim

**Files:**

- Modify: `plan.md`
- Possibly modify: `guardrails-core/src/state-store.ts`, `.gitignore`

`plan.md` has asserted since Phase A that solo→team is _"config plus a publish,
not a rewrite"_. This task **tests that claim** rather than restating it.

**The prediction to falsify** (spec §8.3): `enforcement: block` +
`distribution: team` + a required CI check is genuinely config-only, but
_committing `recurrence.json`_ is probably not — the ledger lives under
`.guardrails/state/`, which is gitignored **and** swept on a 7-day TTL, so a
committed ledger would be both ignored and eventually deleted.

- [ ] **Step 1: Establish the facts**

Read `stateDirectory`, `sweepStale`, `SESSION_TTL_MS`, and the `.gitignore`
entry. Determine, with evidence:

- Where does `recurrence.json` actually live?
- Is it gitignored?
- Does `sweepStale` delete it, or only session files?

Record what you find. **Do not assume the prediction is right** — the point of
the task is to check.

- [ ] **Step 2: Rule on what you found**

If the prediction holds, the claim is false as written and the smallest fix is
either moving the ledger out of `state/` or exempting it from both the ignore and
the sweep. **Implement the smaller of the two**, with a test.

If the prediction is wrong — for instance `sweepStale` already spares
`recurrence.json` — then the claim may be true and the work is to say so
precisely.

- [ ] **Step 3: Update `plan.md`**

Replace the "Solo → team" section's assertion with what you actually verified:
the procedure, what is genuinely config-only, and what needed a change. Either
outcome is a result; do not force it toward the prediction.

- [ ] **Step 4: Verify and commit**

---

## Done criteria

- `mise exec -- npm run lint && npm run typecheck && npx vitest run` all pass.
- `mise exec -- npm run test:coverage && npm run check:graph` at 0 above threshold.
- Mutation over every changed source file: 0 survived, 0 no-coverage.
- `mise exec -- npm run smoke:tarball` green.
- `mise exec -- node guardrails-core/dist/cli.mjs gate --mode=commit` exits 0.
- `mise exec -- npm run build` leaves `git status` clean (generated output committed).
- `guardrails.config.json` still has exactly 27 `sanctionedSuppressions` entries.
- `init --apply` on a fresh fixture installs `crushing-mutants` and
  `boundary-validation` but **not** `adopting-guardrails`, and writes a
  `.github/copilot-instructions.md` index whose entries carry trigger text.
