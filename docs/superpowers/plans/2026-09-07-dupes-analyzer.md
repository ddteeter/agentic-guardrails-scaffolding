# `dupes` Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-file clone-detection analyzer (`dupes`, on `fallow dupes`) to guardrails-core, defaulting to `off`, closing the gap that `sonarjs/no-identical-functions` cannot cover because ESLint is per-file.

**Architecture:** A new adapter parses `fallow dupes --format json` into `Violation[]`, scoped in-adapter to clone groups touching the changed-file set. A new `ANALYZERS` entry runs it at the commit rung. A one-line default-mode table in `analyzer-policy.ts` makes it opt-in. `.fallowrc.jsonc` joins the SEED-ONCE class. Two drift guards pin the rule id and the live runner.

**Tech Stack:** TypeScript (strict), vitest, Stryker, `fallow@3` (already a devDependency).

**Spec:** `docs/superpowers/specs/2026-09-07-dupes-analyzer-design.md`

## Global Constraints

- **TDD.** No production code without a failing test first.
- **Never weaken a rule to pass it.** No `eslint-disable`, `@ts-ignore`, `as any`, `.skip`, no raised thresholds.
- Analyzer invocations stay **config-agnostic and layout-generic**: no `--config`, no hardcoded repo paths, no tuning flags that would override the adopter's own config file.
- `ruleId` is `fallow/code-duplication` — fallow's own `rule_id`, verbatim.
- Adapters are defensive: malformed JSON returns `[]`, never throws.
- Commit in small, logical steps. `npm run test:coverage && npm run check:graph` is the pre-push gate.

---

### Task 1: The adapter

**Files:**

- Create: `guardrails-core/src/verify/fallow-adapter.ts`
- Create: `guardrails-core/test/verify/fallow-adapter.test.ts`

**Interfaces:**

- Produces: `parseFallowDupesJson(stdout: string, changedFiles: readonly string[]): Violation[]`

- [ ] **Step 1: Write the failing tests** — a cross-file group with one side changed yields a violation for _both_ instances; a group touching nothing changed yields none; malformed JSON yields `[]`; the message names the sibling sites.
- [ ] **Step 2: Run and watch them fail** (`npx vitest run guardrails-core/test/verify/fallow-adapter.test.ts`).
- [ ] **Step 3: Implement** the shape guard (`clone_groups` array; each with an `instances` array of `{ file: string, start_line: number }`) and the mapping.
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Commit.**

### Task 2: Default-mode table

**Files:**

- Modify: `guardrails-core/src/verify/analyzer-policy.ts`
- Modify: `guardrails-core/test/verify/analyzer-policy.test.ts`

- [ ] **Step 1:** Failing test — `analyzerMode({}, 'dupes')` is `'off'`; `analyzerMode({}, 'eslint')` is still `'auto'`; an explicit `{ dupes: 'required' }` still wins.
- [ ] **Step 2:** Watch it fail.
- [ ] **Step 3:** Add `DEFAULT_MODES` and `analyzers[tool] ?? DEFAULT_MODES[tool] ?? 'auto'`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit.

### Task 3: Registry entry + runner

**Files:**

- Modify: `guardrails-core/src/verify/index.ts` (`runDupes`, `ANALYZERS`)
- Modify: `guardrails-core/package.json` (peer dep `fallow`, optional)
- Modify: `guardrails-core/test/verify/orchestrator.test.ts`

- [ ] **Step 1:** Failing test — with `{ dupes: 'required' }` and a stubbed exec, `runVerify` spawns `fallow dupes --format json --quiet` and surfaces the parsed violation; with no `dupes` key it never spawns fallow.
- [ ] **Step 2:** Watch it fail.
- [ ] **Step 3:** Implement `runDupes` and the table entry; declare the peer dependency (`peer-dependencies.test.ts` enforces this and needs no edit).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit.

### Task 4: Loose classification

**Files:**

- Modify: `guardrails-core/src/loose-rules.ts`
- Modify: `guardrails-core/test/loose-rules.test.ts`

- [ ] **Step 1:** Failing test — `isBuiltinLoose('fallow/code-duplication')` is `true`.
- [ ] **Step 2:** Watch it fail.
- [ ] **Step 3:** Add `'fallow/'` to `LOOSE_PREFIXES`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit.

### Task 5: The seed

**Files:**

- Modify: `guardrails-core/src/scaffold/seeds.ts` (`FALLOW_SEED`)
- Modify: `guardrails-core/src/scaffold/templates.ts` (`SEED_ONCE_ANALYZERS`)
- Modify: `guardrails-core/src/scaffold/plan.ts` (`SEED_ONCE_PATHS`)
- Modify: `guardrails-core/src/scaffold/detect.ts` (`hasFallowConfig`)
- Modify: the scaffold tests under `guardrails-core/test/scaffold/`

- [ ] **Step 1:** Failing tests — `detect` reports `hasFallowConfig` for each of the four filenames; `buildDesiredFiles` seeds `.fallowrc.jsonc` when `dupes` is enabled and no config exists, and does not when `dupes` is unset (default `off`) or a config is already present; `classifyFile('.fallowrc.jsonc')` is `'seed-once'`.
- [ ] **Step 2:** Watch them fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit.

### Task 6: Drift guards

**Files:**

- Modify: `guardrails-core/test/drift/registry.test.ts`
- Create: `guardrails-core/test/drift/dupes-runner.test.ts`
- Create: `guardrails-core/test/drift/dupes-fixture/` (two files sharing a body, plus a unique third)

- [ ] **Step 1:** Id probe — read fallow's published `issue-registry.json` and assert `fallow/code-duplication` is still a rule id.
- [ ] **Step 2:** Runner guard — spawn real `fallow dupes` over the fixture, feed stdout through `parseFallowDupesJson` with both clone files as the changed set, assert two violations naming both files.
- [ ] **Step 3:** Confirm the fixture is excluded from knip / fallow / tsconfig / eslint the way `knip-fixture` is. **Step 4:** Full suite green. **Step 5:** Commit.

### Task 7: Documentation

**Files:**

- Modify: `README.md`, `docs/adoption.md`, `plan.md`

- [ ] **Step 1:** adoption.md — add `dupes` to the cadence/scope table, to the SEED-ONCE row, and a "Known limits" entry for the TypeScript-only change set.
- [ ] **Step 2:** README — name it in the analyzer list.
- [ ] **Step 3:** plan.md — record the decision, the measurements, and #41 as the deferred half.
- [ ] **Step 4:** `npm run format` and full gate. **Step 5:** Commit.

## Self-Review

- **Spec coverage:** §2 → Task 3; §3 → Task 1; §4 → Task 1 (no threshold parsed); §5 → Tasks 1+3; §5.1 → Task 2; §6 → Task 5; §7 → Task 4; §8 → Task 6; §9 → Task 7.
- **Type consistency:** `parseFallowDupesJson(stdout, changedFiles)` is the only new exported signature and is used identically in Tasks 1, 3 and 6.
