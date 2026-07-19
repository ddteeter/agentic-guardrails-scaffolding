# Phase C, piece 2 — dependency-cruiser + analyzer registry

**Status:** design (approved to plan)
**Date:** 2026-07-19
**Phase:** C (TS pack complete + workspaces)
**Seeds:** `plan.md` §"Build phases" (C) + §"Phase C status", the piece-1 design
(`docs/superpowers/specs/2026-07-18-phase-c-knip-drift-guard-design.md`),
`guardrails-core/src/verify/`, `guardrails-core/src/loose-rules.ts`,
`guardrails-core/src/drift-guard.ts` + `test/drift/registry.test.ts`.

## 1. Why dependency-cruiser, and why now

dependency-cruiser (DC) is the **2nd Phase-C analyzer** and the one whose arrival
was pre-committed as the trigger for the deferred analyzer-registry refactor
(piece-1 design §4: "that refactor lands when dependency-cruiser — the 2nd
commit-rung analyzer — arrives"). Its `dependency-cruiser/` loose prefix is
already forward-declared in `loose-rules.ts`.

**What DC gives us that nothing else in the pack does — and the redundancy we
reject.** The repo already runs `fallow` (coverage-backed dead-code graph, the
`check:graph` pre-push gate) and knip (unused files/exports/deps). DC's
orphan/unresolved detection would merely re-report what those two already catch —
so those rules are **off**. DC earns its place only through the one thing no
other analyzer — present or planned (knip, semgrep, stryker) — can express:
enforcing the **shape** of the dependency graph against authored rules
(circular deps, forbidden/layering edges). This is a **loose / judgment class**:
a green fix (delete the import, invert the dependency, add an allow-exception) is
easily not a good one — the canonical case for the thorough-fixer tier.

**Two value questions, answered separately.**

- **Product value (primary):** guardrails-core is the deliverable — an npm
  package that gates _consumer_ repos, which have real layers. A DC adapter is
  how the TS pack gains module-boundary enforcement at all. Worth it independent
  of this repo's own needs.
- **Dogfood value (thin but real, by design):** this repo is a near-single-package
  workspace (`workspaces: ['guardrails-core']`; `guardrails-plugin/` has no
  importable code; one root script `scripts/sync-agents.mjs`). Boundary rules
  that would be vacuous here (`core↛plugin`) are dropped; the ruleset is trimmed
  to what has genuine teeth on _this_ graph (§4). Thin first-enable findings are
  accepted, not padded with redundant rules.

## 2. Scope

**In scope**

1. A **min-rung analyzer registry** in `verify/index.ts`, replacing the
   `if (profile !== 'stop')` branch with a per-analyzer `minRung` declaration.
2. A **`parseDepcruiseJson` adapter** mapping `depcruise --output-type json` into
   `Violation[]`, dispatched from `runVerify` at the commit rung, exactly as knip.
3. A **`.dependency-cruiser.cjs`** config with three teeth-having rules (§4).
4. A **drift-guard registry entry** (`test/drift/registry.test.ts`) — a third,
   structurally-distinct probe over DC's upstream-owned vocabulary (§6).

**Out of scope** (each a named follow-up, not a gap)

- **Affected-package scoping** — waits for a 2nd workspace member.
- **Throttled Stop tier / live loose-routing** — DC's `dependency-cruiser/`
  loose-classification stays intentionally dormant under the block-only commit
  gate, identical to knip's cut.
- **Parallel analyzer execution** — the registry is shaped so `Promise.all` is a
  trivial future swap, but execution stays serial (§3).
- **Orphan / unresolved rules** — fallow + knip own dead-code; enabling them in
  DC would be redundant.
- **semgrep, stryker** — later pieces.
- **`audit.ts` suppression-signature drift** — DC adds no suppression signatures;
  still the drift-guard's documented next registry entry.

## 3. The analyzer registry (the refactor)

`runVerify` currently hardcodes `runKnip` (with an internal
`if (profile === 'stop') return []`) then `runEslintAndTsc`. A second commit-rung
analyzer makes "each analyzer declares its minimum rung" the honest model. The
refactor introduces a small table and moves rung-gating out of `runKnip`:

```ts
type Rung = 'stop' | 'commit' | 'ci';
const RUNG_ORDER: Record<Rung, number> = { stop: 0, commit: 1, ci: 2 };

interface Analyzer {
  tool: string;
  minRung: Rung;
  run: (
    options: VerifyOptions,
    resolveBin: (tool: string) => string,
  ) => Promise<Violation[]>;
}

const ANALYZERS: Analyzer[] = [
  { tool: 'knip', minRung: 'commit', run: runKnip },
  { tool: 'dependency-cruiser', minRung: 'commit', run: runDepcruise },
];
```

`runVerify` filters by `RUNG_ORDER[profile] >= RUNG_ORDER[analyzer.minRung]` and
runs the applicable analyzers in a **serial loop**, then appends
`runEslintAndTsc`. `runKnip` loses its internal `if (profile === 'stop')` guard —
the table now owns rung-gating (a whole-graph analyzer still runs independent of
`files.length`).

**ESLint/tsc stay outside the table — deliberately.** They are diff-scoped
(gated on `files.length`, run at _every_ rung including stop), not rung-gated.
Forcing them into a `minRung` table would misrepresent their gating. This is the
same asymmetry the piece-1 design named; the registry models whole-graph
analyzers, and eslint/tsc remain the diff-scoped special case.

**Serial, not parallel — a measured optimization deferred.** Each analyzer is an
independent shell-out through the injected `Exec` returning its own
`Violation[]`; parallelizing is correctness-safe (`spawnExec` resolves on
non-zero exit — that is how eslint/tsc/knip already report findings — so
`Promise.all` would not spuriously reject on findings, and array-order flatten
keeps output deterministic). It is **not** done now because knip, DC, and tsc
each build a full TS/module graph; running them concurrently spikes memory (three
graph-builders at once), and the commit-rung budget is seconds — we have not
measured that serial is too slow. The `map`-shaped table makes `Promise.all` a
one-line future change; parallel is a measured optimization, not a speculative
one.

**Callers unchanged.** `runStopGate` (`profile: 'stop'`), `runCommitGate`
(`profile: 'commit'`), and CLI/CI (`profile: 'ci'`) already pass `profile`; the
registry lives entirely inside `verify/index.ts`.

**Future / when semgrep arrives (revisit hint — also carried into the plan).**
semgrep is the first _diff-scopable_ analyzer (the piece-1 design flags it as
possibly riding the _stop_ rung, not commit) and stryker the first _CI-only_ one.
Those two will stress the table's assumptions — it models only `minRung`, not a
diff-scope policy. When semgrep lands, re-evaluate whether `minRung` alone
suffices or the table must graduate to the fuller per-analyzer abstraction (bin +
adapter + diff-scope policy + min-rung as one object), and reconsider parallel
execution under a measured commit-gate budget. Not now: two commit-rung analyzers
do not justify those seams.

## 4. `.dependency-cruiser.cjs` — three rules, all teeth

The repo is `"type": "module"`, so the config is **`.dependency-cruiser.cjs`**
(DC configs are CommonJS `module.exports`; a `.js` file would be mis-read as
ESM). DC runs from the repo root, cruising `guardrails-core/src` with
`--ts-config guardrails-core/tsconfig.json` (TS resolution; the repo uses
relative `.js` ESM imports, no path aliases, but the flag is safe insurance).
All rules are authored `severity: 'error'` so they block the commit.

1. **`no-circular`** — `from: {}`, `to: { circular: true }`. Universal; no other
   analyzer flags cycles. Must be run at first-enable to confirm the repo is
   cycle-free (§8).
2. **`not-to-test-from-src`** — `from` a `src` module that is not itself a test,
   `to` a `*.test.ts` / `*.spec.ts` / `/test/` module. Production code must not
   import test helpers/fixtures. Clean today (verified: no `src → test` imports);
   cheap insurance against regression.
3. **`exec-seam`** — `from` a `src` module other than `src/exec.ts`, `to` matching
   `node:child_process`. Enforces the codebase's core invariant — "every
   shell-out goes through the injected `Exec`" — which the entire test strategy
   rests on. `node:child_process` is imported by exactly one file (`src/exec.ts`,
   verified). This is the rule that makes DC genuinely earn its place in _this_
   repo, and a textbook loose-class specimen: a green fix (inline the spawn, or
   route it wrong) is easily a bad one.

The config-rule-condition keywords these rules use — `circular`, `path`,
`pathNot` (and `dependencyTypes` if used to match the core builtin) — plus the
severity enum are exactly the drift-guard's `knownIds` (§6).

## 5. `parseDepcruiseJson` adapter

A new pure function mirroring `parseKnipJson`, over `depcruise --output-type
json`. DC's top-level shape is `{ summary: { violations: Violation[], ... },
modules: [...] }`; the adapter reads `summary.violations`.

| Field      | Value                                                                                          | Rationale                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ruleId`   | `dependency-cruiser/${v.rule.name}`                                                            | Lands under the existing `dependency-cruiser/` loose prefix.               |
| `file`     | `v.from`                                                                                       | The module that owns the offending edge; DC emits repo-relative paths.     |
| `message`  | circular → `Circular dependency: <cycle joined with " → ">`; else `<rule.name>: <from> → <to>` | Names the forbidden edge or the cycle so the fixer sees the actual graph.  |
| `severity` | DC `error → 'error'`; DC `warn`/`info → 'warn'`; DC `ignore` → skipped                         | `Severity` is `'error' \| 'warn'` only.                                    |
| `fixable`  | `false`                                                                                        | DC has no safe autofix; graph fixes are judgment, never a silent autofix.  |
| `line`     | omitted                                                                                        | DC `summary.violations` are module-level (like knip's whole-file entries). |
| `tool`     | `'dependency-cruiser'`                                                                         |                                                                            |
| `package`  | `packageId` pass-through                                                                       | Real per-package attribution is the affected-scoping work later.           |

Empty / malformed JSON, or a payload without a `summary.violations` array,
returns `[]` — mirroring `parseKnipJson`'s defensive parse. A runtime shape guard
(`isDepcruiseReport`) narrows the parsed value before access, matching
`isKnipReport`.

**Scoping — project-wide, clean-baseline.** DC is whole-graph; a forbidden edge
lives on the file that _has_ the import, which this commit may not have touched.
Post-hoc filtering to changed files would discard exactly the cross-file findings
that are the point. DC runs project-wide and reports everything, matching tsc's
and knip's existing stance (see `verify/index.ts` header). The same
clean-baseline caveat applies (§8).

**Reporter-shape confirmation.** DC is not yet installed; the exact
`summary.violations` field names (`from`, `to`, `rule.name`, `rule.severity`,
`cycle`) are the contract, verified against the installed DC version when the
fixture is captured (same "confirm then" stance knip took in piece 1). If the
installed DC's field access differs, adjust the adapter's reads only.

## 6. Drift-guard entry — the third, structurally-distinct probe

The registry (`DriftEntry { tool, knownIds, probe, hint }` asserting
`knownIds ⊆ probe()`) already holds a knip probe (issue-type keys from a real
run) and an eslint-family probe (rule ids from the flat config + core). DC needs
a third that is **honestly distinct**, and the honest distinction is: **DC's rule
_names_ are authored by us**, not a fixed upstream enum. So the probe cannot
target rule names — it targets what **upstream owns and can rename on upgrade**:

- the config-rule-**condition keywords** our `.dependency-cruiser.cjs` depends on
  (`circular`, `path`, `pathNot`, and `dependencyTypes` if used), and
- the **severity enum** values we map (`error`, `warn`, `info`).

`knownIds = ['circular', 'path', 'pathNot', 'error', 'warn', 'info']` (plus
`dependencyTypes` if the exec-seam rule uses it). The worst-case drift this
catches is silent: a DC upgrade renames `circular` → cycles stop being detected
with no error.

**Probe source — resolved at implementation** (mirroring knip's import-vs-fixture
resolution): **prefer importing DC's exported config JSON-schema** (or config
types) and collecting the condition-property names + severity enum from it;
**fallback** to a golden `.cjs` + fixture run of real depcruise, reading the
accepted-config + emitted-severity vocabulary. The schema-import path is
**preferred specifically because it needs no fixture** — dodging the piece-1
finding where a drift fixture under a workspace test glob polluted four configs
(`knip.json`, `tsconfig.json`, `eslint.config.js`, `.fallowrc.jsonc`). If a
fixture is unavoidable, it must be excluded from those same scopes; note also
that DC cruises only `guardrails-core/src`, so a fixture under `test/drift/` is
already outside DC's own target.

`hint`: points at `.dependency-cruiser.cjs` + `verify/depcruise-adapter.ts` —
"a DC upgrade renamed/removed a rule-condition keyword or severity; reconcile the
config and adapter."

**Coverage note.** This guards the id-existence half for DC (its
upstream-owned vocabulary). The `dependency-cruiser/` loose _prefix_ in
`loose-rules.ts` is a family match needing no per-name assertion; the eslint-family
probe already documents `dependency-cruiser/` as "no eslint plugin — covered by
its own probe," which this entry now satisfies.

## 7. Testing (all TDD-first)

- **`parseDepcruiseJson`** — unit tests over captured DC JSON fixtures: a circular
  violation (cycle message, no `line`), a forbidden-edge violation (`ruleId` /
  `from` / message shape), severity mapping (`error`/`warn`/`info`, `ignore`
  skipped), `fixable: false`, empty/malformed JSON → `[]`, missing
  `summary.violations` → `[]`, `package` pass-through.
- **Registry** — a `rungAtLeast` (or `RUNG_ORDER`-comparison) unit test; and
  `runVerify` via the injected `exec` mock: knip + DC both dispatched at `commit`
  and `ci`, neither at `stop`, eslint/tsc dispatched at all rungs gated on
  `files.length`.
- **Gates** — `runCommitGate` surfaces (and blocks on) DC violations; `runStopGate`
  does not run DC.
- **Drift-guard** — the new DC entry runs against real DC (schema-import or
  fixture) and passes on the current version; a renamed keyword would fail with
  `hint`. The registry-iteration/assert/hint logic itself is already covered by
  piece 1's fake-probe test.

## 8. Enablement (a step, not a surprise)

Sequence: add `.dependency-cruiser.cjs` + the `dependency-cruiser` devDep → run
`depcruise` → clean any findings → wire `runDepcruise` into the registry at the
commit rung. `exec-seam` and `not-to-test-from-src` are already clean (verified);
`no-circular` must be run to confirm the repo is cycle-free. The repo must be
DC-clean before the commit gate relies on it (clean-baseline, matching tsc/knip).
Any real first-enable finding is dogfood signal — cleaned as ordinary work, never
routed around by weakening a rule.

## 9. Risks / open items

- **DC JSON reporter shape** — confirmed against the installed DC version when the
  fixture is captured (§5); the mapping table is the contract.
- **Probe source** (schema-import vs golden fixture) — resolved at implementation
  against the installed DC version (§6).
- **First-enable findings** — likely already clean except cycles; any finding is
  expected dogfood signal (§8).
- **Dormant loose-class** — intentional under the block-only commit gate (§2),
  activated later by the throttled Stop tier, exactly as knip.
- **Config format** — `.dependency-cruiser.cjs` (CommonJS) because the repo is
  ESM; a `.js` config would be mis-parsed (§4).
