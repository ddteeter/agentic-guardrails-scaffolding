# Phase C, piece 3 — enable + loose-classify `no-unsafe-type-assertion` (the piece that replaced semgrep)

**Status:** design (approved to plan)
**Date:** 2026-07-21
**Phase:** C (TS pack complete + workspaces)
**Seeds:** `plan.md` §"Build phases" (C) + §"Phase C status" (pieces 1–2 shipped),
the piece-2 design (`docs/superpowers/specs/2026-07-19-phase-c-dependency-cruiser-design.md`),
`plan.md` §"Boundary type-safety" (lines ~201–215), `guardrails-core/src/loose-rules.ts`,
`guardrails-core/src/config.ts` + `gate-decision.ts`, `test/drift/registry.test.ts`.

## 1. What this piece is, and why it is not semgrep

`plan.md` §"Build phases" names **semgrep** as the 3rd Phase-C analyzer. Investigation
retired that choice; this piece is the honest resolution of the "semgrep slot," and it
turned out not to be an analyzer at all.

**Why not semgrep** (each verified empirically, not from docs — semgrep 1.170.0 installed
and tested):

- **Not npm-installable.** The only `semgrep` on npm is an abandoned pre-1.0 stub
  (`0.0.1`, 2020, `returntocorp/sgrep`). Real semgrep ships via pip/Homebrew/Docker
  only — **zero standalone binary release assets**. A Node package cannot pin it
  reproducibly without Docker or a third-party republisher. Every other analyzer in
  the pack resolves through `node_modules/.bin`; semgrep would be the first that
  can't.
- **Its headline capability is paywalled.** Cross-file and interprocedural taint are
  **Pro-only** (verified: `helper(req.q)` → `document.write(s)` was missed in CE).
  Free-tier taint is single-function only — near ast-grep's syntactic ceiling for the
  rules we'd actually author.
- **Its rules can't be redistributed.** Since Dec 2024 registry rules ship under the
  Semgrep Rules License, which forbids redistribution — so guardrails-core (which
  ships into consumer repos) **cannot bundle rule packs**. Unvendored registry rules
  are unversioned, re-fetched over the network every run, and telemetry-enabling by
  default (`--metrics=auto`).
- **Too slow for the budget.** ~1.3–1.7s/scan vs the measured ~1.0s serial commit
  gate (knip 0.24 + depcruise 0.31 + tsc 0.47). ~0.5s Python startup floor alone.

**Why not ast-grep instead** (the npm-native structural matcher; `@ast-grep/cli`
0.44.1, tested): operationally excellent (installs clean, ~0.01s full-repo scan, MIT,
offline, author-owned rule ids so no upstream drift) but **analytically shallow** — the
project's own docs state it has no types, no dataflow, no taint, no cross-file, and no
rule registry (local YAML only). It could express structural guardrails, but so can
type-aware ESLint, which we already run.

**The finding that collapsed the piece.** The concrete rule this slot existed to add —
`plan.md` §"Boundary type-safety": _"unvalidated deserialization / structural `as` cast
at a trust boundary … extend it (semgrep or a custom ESLint rule) … route it as a loose
class"_ — **already exists** as `@typescript-eslint/no-unsafe-type-assertion` (shipped
typescript-eslint v8.15.0, Nov 2024; type-aware; installed here at 8.63.0). It fires on
exactly `JSON.parse(x) as T` ("unsafe narrowing from `any`") and is off-by-default,
in no recommended config. So there is no analyzer to add and no rule to author. The
guardrail move is what guardrails-core already does best: **curate an existing rule and
classify it.** A custom rule would be reinventing upstream's.

**Product framing (the deciding lens).** guardrails-core gates _future consumer repos_,
not this (already-clean) one. The `no-unsafe-*` family alone can't catch the
green-but-wrong boundary cast — adding `as T` launders `JSON.parse`'s `any` into a typed
value, which is the _documented fix_ for `no-unsafe-assignment`, i.e. the cast is
exactly what makes the code green. `no-unsafe-type-assertion` is the rule that closes
that hole, and the ecosystem left it off-by-default (too blunt to adopt raw). A
guardrail that turns it on **and routes it to the tier that judges fix quality** is
filling a real, defensible gap — "a good rule nobody enables" — not inventing one.

## 2. Scope

**In scope** — three changes, all in `guardrails-core`:

1. **Loose-classify** `no-unsafe-type-assertion` in `loose-rules.ts` (the product change).
2. **Enable** the rule in this repo's `eslint.config.js` (the dogfood proof).
3. **Drift-guard** the rule id in the eslint-family probe (`test/drift/registry.test.ts`).

**Out of scope** (each a named follow-up, not a gap):

- **No custom ESLint rule / plugin.** The upstream rule is type-aware and strictly
  better than a hand-rolled one; authoring our own would reinvent it.
- **No scaffold enablement.** Turning the rule _on_ in consumer repos is the
  `scaffold-typescript-project` skill's / Phase E's job. This piece ships the
  _classification_ to all consumers and enables the rule _here_; §7 records the
  forward-link.
- **No validator recommendation / fixer-guidance change.** Pointing agents at a
  runtime validator (zod/valibot) as the _good_ landing zone is a separate roadmap
  item (`plan.md` §"Boundary type-safety" product track). Adopting a validator makes
  this rule **correctly silent** (§4), so nothing here is hostile to that future.
- **No semgrep / ast-grep adapter, no analyzer-registry change.** `verify/index.ts`'s
  `ANALYZERS` min-rung table is untouched — this piece adds no analyzer. The
  registry-graduation question (diff-scope policy, parallel execution) that piece 2
  deferred "to semgrep" is **re-deferred to stryker**, the remaining Phase-C analyzer
  and the first genuinely CI-only one. Serial execution stays (measured ~1.0s; see §1).
- **The `ts-runtime-checks` marker-cast false positive** — the one library family where
  a _validated_ value is still written `as Assert<T>` (§6). Documented edge with a
  clean escape; no machinery now.

## 3. The three changes

### 3.1 Loose-classify (`loose-rules.ts`) — the product change

Add `no-unsafe-type-assertion` to `LOOSE_RULE_NAMES` (the name-after-last-`/` set), not
to an exact-id list. Rationale: `eslint-plugin-total-functions` ships a same-named rule
with identical intent, so a name-match classifies both — consistent with the existing
`LOOSE_RULE_NAMES` entries (`expect-expect`, `no-trivial-assertions`, …), which are
generic cross-plugin knowledge.

This is the real product surface. `loose-rules.ts` ships in core's `dist`; the path is
`makeIsLoose` (`loose-rules.ts`) → `config.isLoose` (`config.ts:139`) →
`gate-decision.ts:166` (`violations.some((v) => config.isLoose?.(v))`). So in **any**
consumer repo whose ESLint config has the rule enabled, a `no-unsafe-type-assertion`
violation routes to the **thorough** fixer from attempt 1.

**Why loose is load-bearing, not decorative.** The rule's suggested fix is _"consider
using type guards or a safer assertion,"_ which has green-but-worse paths — widen the
cast, or delete it — that satisfy the linter without making the code safer. The thorough
tier weighs whether a fix is _good_, not merely green. The classification is what makes
enabling this rule safe; the two are one feature.

### 3.2 Enable (`eslint.config.js`) — the dogfood proof

Add `'@typescript-eslint/no-unsafe-type-assertion': 'error'` to this repo's flat config.
The config is already type-aware (`strictTypeChecked` + `projectService: true`), which
the rule requires (it uses `isTypeAssignableTo`, TS ≥ 5.4). This makes the loose
classification exercisable here and is the dogfood half of the piece.

**Clean baseline verified** (0 findings across every boundary module: hook-io, gate,
state-store, config, violation, all four verify adapters). The repo's casts are all
either post-guard-narrowed (`isRecord(parsed)` narrows `unknown`→`Record` _before_ the
cast) or target all-optional types (`RawHookPayload = Partial<Pick<…>>`), so the rule
correctly reads them as safe. Enabling will not break the gate.

### 3.3 Drift-guard (`test/drift/registry.test.ts`)

Add `@typescript-eslint/no-unsafe-type-assertion` to the **existing eslint-family
entry's** `knownIds` — no new probe. It is an eslint-family rule id, exactly what
`eslintRuleIds()` collects (verified: the probe collects it; 823 ids gathered including
this one, from `@eslint/js` `configs.all` + the flat config's plugin blocks). A
ts-eslint upgrade that renamed/removed it fails the build with the entry's hint. The
registry-iteration/assert/hint logic itself is already covered by piece 1's fake-probe
test.

## 4. Rule semantics and the validator interaction (why "enable" stays coherent)

Semantics (verified on synthetic fixtures): the rule forbids **narrowing** assertions
(`any`/`unknown` → concrete) and permits **widening** ones (`T` → `unknown`). It fires
on `JSON.parse(x) as Domain` and `unknown as Domain`; it allows `x as unknown`.

The key question — _what happens when a consumer adopts a validator?_ — was tested, and
the answer is the desired one: **the rule becomes correctly silent, because the cast is
gone.**

| Pattern                                                         | `as` cast? | Rule fires?                   |
| --------------------------------------------------------------- | ---------- | ----------------------------- |
| `schema.parse(JSON.parse(x))` (zod / valibot / arktype / typia) | none       | **no**                        |
| `if (isDomain(raw)) { … }` (type-guard predicate narrows)       | none       | **no**                        |
| `JSON.parse(x) as Domain` (naked)                               | yes        | **yes** ← the target          |
| `JSON.parse(x) as Assert<Domain>` (`ts-runtime-checks` marker)  | yes        | **yes** ← false positive (§6) |

Mainstream validators return `T` directly and a proper type guard narrows via its
predicate — neither produces an assertion, so there is nothing to flag. The rule is not
rendered vestigial by validator adoption; it is the _pressure that drives_ adoption and
goes quiet once the code lands somewhere safe. That is the correct guardrail behavior:
it stops complaining because the code got safer, not because it was suppressed.

## 5. Testing (TDD-first)

- **`loose-rules`** unit test: `isBuiltinLoose('@typescript-eslint/no-unsafe-type-assertion')`
  → true (and a `makeIsLoose(...)` predicate test over a `{ ruleId }` shape, mirroring
  existing loose-rules tests).
- **Drift** : the eslint-family entry now asserts the id exists upstream (added to
  `knownIds`); a rename fails with the hint. No new probe or fixture.
- **Enablement gate** : `npm run lint` clean with the rule on (verified pre-design; it
  is the enablement precondition, matching tsc/knip/DC clean-baseline discipline).

No new adapter, orchestrator, or gate test — this piece adds no analyzer and no new
`verify` dispatch path.

## 6. Risks / edges

- **`ts-runtime-checks` / `ts-safe-cast` marker casts** — the one family where a
  _validated_ value is deliberately expressed `as Assert<T>`; the rule can't tell it
  from a naked cast and will false-positive. Minority approach (the dominant validators
  are cast-free). Escape: a consumer owns their config and can scope the rule off those
  sites; the loose-fixer could later learn the marker types. Documented, not solved.
- **Green-but-worse fix** — mitigated by the loose→thorough routing (§3.1); this is
  _why_ the classification is mandatory rather than optional.
- **Rule stays off in consumer repos until the scaffold enables it** — this piece ships
  the classification and enables it here only; consumer enablement is the scaffold's
  job (§7). Until then the classification is dormant for consumers, exactly as knip's /
  DC's loose class is dormant under the block-only commit gate.
- **`any` vs `unknown` handling** — both are flagged (verified via the declined
  `ignoreUnknown` upstream request + the JSON.parse example). If a future design leans
  on the distinction, read the rule's implementation before relying on it.

## 7. Forward-links (named, not built here)

- **Scaffold enablement (Phase E / `scaffold-typescript-project`).** The scaffold's
  shipped ESLint template should enable `no-unsafe-type-assertion` on-by-default so
  consumers land in the loose-routed state automatically. This piece makes that a
  one-line template add whose classification already ships in core.
- **Validator landing zone (`plan.md` §"Boundary type-safety" product track).** Fixer
  guidance / the scaffold should point agents at a runtime validator (zod/valibot) as
  the _good_ fix, per `plan.md`'s "reserve schema libraries for scaffolded target
  repos." §4 shows adopting one satisfies the rule by construction.
- **stryker** is the remaining Phase-C analyzer and now the trigger to revisit the
  `ANALYZERS` registry graduation (diff-scope policy + parallel execution) that piece 2
  deferred "to semgrep."

## 8. Adjacent finding (recorded, out of scope)

During investigation the Stop-gate wrote `.guardrails/state/` **relative to process
cwd** (a drifted cwd produced `guardrails-core/src/.guardrails/state/…`). `plan.md`
already notes the root-anchored gitignore gap; the sharper issue is that state is
cwd-relative, so recurrence ledgers **fragment** across whatever directory the process
runs in — a state-layer correctness bug, not just a gitignore miss. Belongs in
`plan.md` §"Roadmap: fixer-loop hardening", not this piece.
