# Stryker Mutate Scope (issue #69) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stryker analyzer's scope equal the project's declared mutation
scope, so a changed file no positive `mutate` glob covers is reported as
out-of-scope rather than mutated and blocked.

**Architecture:** `runStryker` already reads `stryker.conf.json` and carries its
`!` negations onto the CLI (#56). It still ignores the POSITIVE globs in the same
array, so its effective scope is "every changed TS file that is not explicitly
negated" — the whole repo minus exclusions, which is not what the config says.
This plan reads the positive globs too and intersects the changed set with them,
using Node's built-in `path.matchesGlob` (stable since 24.8.0) rather than a
hand-rolled matcher or a new dependency. Files dropped by the intersection
become a non-blocking `guardrails/stryker-out-of-scope` warning, which preserves
the one property the old behaviour had — noticing a file that has joined no
scope — without the wall of unfixable `no-coverage` violations.

**Tech Stack:** TypeScript (strict) → tsup → `dist/*.mjs`; vitest; eslint +
typescript-eslint + unicorn + sonarjs; knip and fallow for graph analysis;
Stryker for mutation.

**Issue:** https://github.com/ddteeter/agentic-guardrails-scaffolding/issues/69

## Global Constraints

- **TDD is non-negotiable.** No production code without a failing test first.
- **Never weaken a rule to pass it.** No `eslint-disable`, `@ts-ignore`,
  `as any`, `.skip`, deleted assertions, or raised thresholds.
- **Node `>=24.8.0`** (raised by this plan); `"type": "module"`; pure ESM.
- **Zero runtime dependencies.** The glob matcher is `node:path`, not a package.
- **Naming:** `unicorn/prevent-abbreviations` is on — `configuration`, not
  `config`, in new identifiers.
- **Commit in small logical steps.** Every task ends with a commit.

## Why not a glob library

Measured, not assumed. Stryker 10 matches `mutate` patterns in
`config/file-matcher.js` with `minimatch@~10.2.4`, `{ dot: false }` for mutate
patterns, on `path.resolve`'d absolute paths. Node's `path.matchesGlob` agreed
with minimatch on every one of 12 patterns × 11 files — braces, extglobs
(`!()`, `+()`, `@()`), character classes, `?`, `**` spanning, dotfiles, and
stryker's own default pattern verbatim. The only divergence was leading-`./`
normalization, which resolving both sides against `repoRoot` removes.

A `minimatch` dependency would buy parity by construction rather than by
measurement, at the cost of the package's zero-dependency property (minimatch →
brace-expansion → balanced-match land in every consumer's tree). Task 5's drift
test covers the divergence risk that trade leaves behind, and is warranted
either way.

## Noted upstream

Stryker's `ProjectReader.resolveFileDescriptions` already implements exactly
these semantics via `targetMutatePatterns` — it intersects target patterns with
the config's `mutate`. Only the mutation-server protocol passes it;
`stryker.js` hardcodes `targetMutatePatterns: undefined` for the CLI path. Worth
an upstream request for CLI access, but this fix does not wait on one.

## Tasks

### Task 0 — raise the Node floor

- [ ] `package.json` and `guardrails-core/package.json`: `engines.node`
      `">=24.0.0"` → `">=24.8.0"`, the version `path.matchesGlob` became stable.
- [ ] Regenerate `package-lock.json` (it embeds both workspace `engines` blocks).
- [ ] CI needs no change — `node-version: '24'` resolves past 24.8.
- [ ] Consumer-visible: an adopter on 24.0–24.7 gets `EBADENGINE`. Minor-version
      concern for the next release, not a patch.

### Task 1 — read the positive globs

- [ ] Test-first: `strykerMutatePositives(configurationJson)` returns non-`!`
      entries; splits comma-joined entries OUTSIDE brace groups (so
      `src/**/*.{ts,tsx}` survives); strips a trailing mutation range
      (`src/a.ts:1-10` → `src/a.ts`); answers `[]` for absent/malformed config,
      a non-array `mutate`, and non-string entries.
- [ ] Sibling of `strykerMutateNegations` in `guardrails-core/src/verify/index.ts`.
- [ ] Brace-aware splitting is correct HERE and wrong for negations: negations
      are handed to stryker's CLI, which splits on every comma with no brace
      awareness. Positives never reach the CLI. Leave the negation reader alone.

### Task 2 — the matcher

- [ ] Test-first: `matchesMutateScope(file, patterns, repoRoot)` — `**` spanning,
      braces, extglobs, a bare-file pattern, a pattern matching nothing, an
      empty pattern list.
- [ ] `path.matchesGlob`, with pattern and file both `path.resolve`d against
      `repoRoot` — stryker's `FileMatcher` normalization.

### Task 3 — intersect in `runStryker`

- [ ] Test-first, via the existing `strykerMutateArgument` helper in
      `test/verify/orchestrator.test.ts`: an out-of-scope changed file is absent
      from `--mutate`; an in-scope one survives; no positive globs (absent
      config, unparseable config, no `mutate` key) → today's behaviour unchanged.
- [ ] `inScope` — not `production` — feeds all four consumers: the cache-reuse
      set via `applyMutateNegations`, the `--mutate` argument,
      `unrunSurvivedMutants`, and `parseStrykerJson`. Report scoping matters
      independently: stryker folds cached verdicts for out-of-scope files back
      into the report it writes.
- [ ] Empty `inScope` → return the Task 4 warnings, run nothing.

### Task 4 — the out-of-scope signal

- [ ] Test-first: one `severity: 'warn'` violation per dropped file, rule id
      `guardrails/stryker-out-of-scope`, `tool: 'guardrails'`; NO warning for a
      file an explicit `!` negation names (a declared decision, not an unjoined
      file); the gate does not block on it.
- [ ] `guardrails/` rather than `stryker/` deliberately: `guidance.ts` and
      `loose-rules.ts` both match the bare `stryker/` prefix, so a `stryker/`
      name would be classed loose and handed crushing-mutants guidance — wrong
      on both counts for a file nobody is being asked to mutate.
      `guardrails/analyzer-unknown` is the precedent for this shape.

### Task 5 — the drift guard

- [ ] `guardrails-core/test/drift/stryker-scope.test.ts`: a fixture whose
      `stryker.conf.json` declares a `mutate` array, run through REAL stryker
      (`--dryRunOnly`, no `--mutate` override), asserting the file set stryker
      resolves equals the set `matchesMutateScope` resolves.
- [ ] This is what catches Node's glob implementation diverging from minimatch,
      and is the reason a dependency is not needed. Required by CLAUDE.md for
      anything whose value rests on agreeing with a third-party tool.

### Task 6 — docs

- [ ] `plan.md`: a `### Finding (issue #69 …)` section in the shape of the #59
      and #67 entries — #56's fix left the negation array carrying two different
      claims, and what replaced it.
- [ ] Update `strykerMutateNegations`' doc comment, which states the "no
      configuration surface of our own" rationale this change completes.
- [ ] Check `adopting-guardrails` and `crushing-mutants` for text telling an
      adopter to negate a file to quiet the gate.

## Follow-ups (NOT in this change)

- Retire `negationMatcher` / `UNMODELLED_GLOB_SYNTAX` now that a real matcher
  exists. It loosens cache reuse (a behaviour change with its own safety
  argument), so it gets its own change.
- Upstream stryker request: CLI access to `targetMutatePatterns`.
