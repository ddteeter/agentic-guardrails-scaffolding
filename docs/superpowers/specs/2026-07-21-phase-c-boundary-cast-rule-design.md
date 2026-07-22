# Phase C, piece 3 — the "semgrep slot" resolves to a recommendation, not a gate

**Status:** design (approved) — **outcome: no enforcement code ships; a runtime-validator
recommendation is deferred to Phase E**
**Date:** 2026-07-21
**Phase:** C (TS pack complete + workspaces)
**Seeds:** `plan.md` §"Build phases" (C) + §"Phase C status" (pieces 1–2 shipped),
the piece-2 design (`docs/superpowers/specs/2026-07-19-phase-c-dependency-cruiser-design.md`),
`plan.md` §"Boundary type-safety" (~lines 201–215), `guardrails-core/src/loose-rules.ts`,
`guardrails-core/src/config.ts` + `gate-decision.ts`, `test/drift/registry.test.ts`.

## 0. TL;DR (what this piece concluded)

The 3rd Phase-C analyzer slot (`plan.md` names it "semgrep") yielded a **finding and a
redirect, not an analyzer or a gate.** Investigation retired semgrep and ast-grep (§1),
found that the concrete boundary-cast rule the slot existed for already ships upstream
as `@typescript-eslint/no-unsafe-type-assertion` (§2), and then — attempting to
dogfood-enable it — discovered the rule is **not a reliable gate** for this concern (§3).
The reliable intervention is **by construction**: adopt a runtime validator at trust
boundaries. That is a recommendation, owned by the Phase E scaffolder and the
boundary-type-safety roadmap — **not** enforcement code in Phase C. **No code ships in
this piece** beyond this spec and the recorded findings (§5). stryker is the real
remaining Phase-C analyzer.

## 1. Why not semgrep, why not ast-grep

`plan.md` §"Build phases" names **semgrep** as the 3rd Phase-C analyzer. Investigation
retired it (all verified empirically — semgrep 1.170.0 and `@ast-grep/cli` 0.44.1
installed and tested):

**semgrep:**

- **Not npm-installable.** The only `semgrep` on npm is an abandoned pre-1.0 stub
  (`0.0.1`, 2020). Real semgrep ships via pip/Homebrew/Docker only — **zero standalone
  binary release assets**; a Node package can't pin it reproducibly without Docker or a
  third-party republisher. Every other pack analyzer resolves through `node_modules/.bin`.
- **Headline capability paywalled.** Cross-file and interprocedural taint are Pro-only
  (verified: `helper(req.q)` → `document.write(s)` missed in CE). Free-tier taint is
  single-function only.
- **Rules non-redistributable.** Since Dec 2024 registry rules ship under the Semgrep
  Rules License, which forbids redistribution — guardrails-core (which ships into
  consumer repos) **cannot bundle rule packs**. Unvendored packs are unversioned,
  network-fetched every run, and telemetry-enabling by default (`--metrics=auto`).
- **Too slow.** ~1.3–1.7s/scan vs the measured ~1.0s serial commit gate; ~0.5s Python
  startup floor alone.

**ast-grep** (the npm-native structural matcher): operationally excellent (clean install,
~0.01s full-repo scan, MIT, offline, author-owned rule ids so no upstream drift) but
**analytically shallow** — its own docs state no types, no dataflow, no taint, no
cross-file, and no rule registry (local YAML only). It could express structural
guardrails, but so can the type-aware ESLint we already run.

**The pivot from "add a tool" to "there is no tool to add."** The concrete rule the slot
existed for — `plan.md` §"Boundary type-safety": _"unvalidated deserialization /
structural `as` cast at a trust boundary … route it as a loose class"_ — **already
exists** as `@typescript-eslint/no-unsafe-type-assertion` (typescript-eslint v8.15.0,
Nov 2024; type-aware; installed here at 8.63.0). So there was never a new analyzer to
build; the question became whether to enable and classify that existing rule.

## 2. The plan that looked right (and the product framing behind it)

guardrails-core gates _future consumer repos_, not this (guard-heavy, carefully-written)
one — so the deciding lens is consumer value, not our own needs. The plan was the move
core already does best (curate + classify an existing rule, no custom-plugin surface):

1. **Loose-classify** `no-unsafe-type-assertion` in `loose-rules.ts` (the product change,
   flowing `makeIsLoose` → `config.isLoose` (`config.ts:139`) → `gate-decision.ts:166`).
2. **Enable** it in this repo's `eslint.config.js` (the dogfood proof).
3. **Drift-guard** the id in the eslint-family probe.

The rationale: the `no-unsafe-*` family alone can't catch the green-but-wrong boundary
cast — adding `as T` launders `JSON.parse`'s `any` into a typed value (the _documented
fix_ for `no-unsafe-assignment`), i.e. the cast is exactly what makes the code green.
`no-unsafe-type-assertion` is the rule that closes that hole; the ecosystem left it
off-by-default. Classifying it loose (route to the thorough fixer, which judges fix
_quality_) was meant to make enabling it safe.

**All three changes were implemented TDD-first and were green in isolation.** Then the
enable step met the real gate.

## 3. The finding that killed the gate: it is not a reliable detector

`npm run lint` with the rule enabled produced **23 errors**, and almost all were the
**sanctioned parse-don't-validate idiom**, not green-but-wrong casts:

- **Guard-internal narrowing probes** — `(issue as KnipIssue).file === 'string'` inside
  an `isX` type guard: `depcruise-adapter.ts` ×4, `eslint-adapter.ts` ×2,
  `knip-adapter.ts` ×2, `violation.ts:33`.
- **Guard preamble** — `value as Record<string, unknown>` before field checks:
  `violation.ts:41`, `knip-adapter.ts:45`.
- **Generic constraint** — `value as T`: `config.ts` ×2.
- **Test scaffolding** — `as never` for invalid-input tests, the drift probe's own
  introspection casts: 9 findings across 3 test files.

(Notably `hook-io.ts:100–101` — the casts the earlier draft fixated on — are correctly
_not_ flagged: `RawHookPayload = Partial<Pick<…>>` is all-optional, so not a narrowing.)

**Two things this proves.**

1. **The earlier "clean baseline" was a false negative.** It came from a probe config
   that lacked the real gate's TypeScript program, so the type-aware rule silently
   under-reported. Lesson (again — cf. `plan.md` piece-2 "vitest hid the tsc error"):
   **verify against the actual gate command, never a hand-scoped probe.**
2. **The rule cannot distinguish "cast then validate" from "cast and trust."** It flags
   every narrowing assertion, including the standard, safe way to author a TS type guard.
   This repo also **forbids `eslint-disable`**, so a clean repo-wide `error` enable is
   unreachable without rewriting every guard (and some cases — the generic `value as T`
   — resist rewriting at all).

**Why no reliable lint gate exists for this concern** (three independent confirmations):

- **Dogfood:** the rule floods on sanctioned guard code (above).
- **Research:** the ecosystem solved boundary safety with runtime validators, _not_
  linters, for precisely this reason.
- **False-pos/false-neg trap:** narrowing the rule to only the syntactic
  `JSON.parse(x) as T` form would be clean here (every parse site assigns to a variable
  first) but would then _miss_ the equally-dangerous two-line form
  `const p = JSON.parse(x); const d = p as T`. Tightening to kill false positives opens
  false negatives — the property depends on dataflow the linter can't follow. There is
  no reliable **and** complete lint-layer gate.

## 4. The reliable intervention is by construction: a runtime validator

`schema.parse(JSON.parse(x))` (zod / valibot / arktype / typia) returns a typed value
_because it was checked_, produces **no cast**, and leaves nothing to (un)reliably detect
— verified earlier: the rule is silent on validator-returned values and on
type-guard-narrowed values. This is the positive form of the same goal and what
`plan.md` §"Boundary type-safety" already gestured at ("reserve schema libraries for
scaffolded target repos").

So the concern is **real but not gate-shaped**. Shipping the unreliable gate's machinery
(enable + loose-classify) would be worse than shipping nothing: the loose-classification
only matters if the rule is enabled, and shipping it implies "enable this rule," which
this investigation specifically advises against. The classification was therefore
**reverted**, not kept as dormant insurance — coherence over a mixed message.

## 5. What ships in piece 3

**Code: none.** The enable + loose-classify + drift changes were implemented, the enable
step surfaced §3, and **all three were reverted.** The tree returns to the piece-2
baseline plus this spec and the recorded findings.

**Deliverable: the recorded decision + a named forward obligation.**

- `plan.md` §"Phase C status" records that the semgrep slot resolved to a recommendation,
  not an analyzer, with the §3 finding.
- `plan.md` §"Boundary type-safety" / §"Roadmap" carries the **runtime-validator
  recommendation** as Phase-E-owned work: the scaffolder's shipped template should adopt
  a validator (zod/valibot/typia) at trust boundaries so the safe pattern exists by
  construction, and fixer/scaffold guidance should point boundary casts there rather
  than at deletion.

## 6. Out of scope / forward-links

- **No custom ESLint rule / plugin** — a hand-rolled rule faces the same reliability wall
  (§3) and would reinvent the upstream one.
- **No analyzer-registry change.** `verify/index.ts`'s `ANALYZERS` min-rung table is
  untouched — this piece adds no analyzer. The registry-graduation question (diff-scope
  policy, parallel execution) piece 2 deferred "to semgrep" is **re-deferred to stryker**,
  the remaining Phase-C analyzer and the first genuinely CI-only one. Serial execution
  stays (measured ~1.0s).
- **Runtime-validator adoption** is Phase E (scaffolder) + the boundary-type-safety
  roadmap, not Phase C.
- **stryker** is the next real Phase-C analyzer.

## 7. Adjacent finding (recorded separately, out of scope)

During investigation the Stop-gate wrote `.guardrails/state/` **relative to process cwd**
(no git-root resolution exists in `src`; `repoRoot = input.cwd ?? deps.cwd`), so
operating the repo from different working directories fragments the `recurrence.json`
ledger and leaks un-ignored nested `.guardrails/` dirs. Verified and recorded in
`plan.md` §"Roadmap: fixer-loop hardening" with the fix direction (resolve `repoRoot` via
`git rev-parse --show-toplevel` through the injected `exec`).
