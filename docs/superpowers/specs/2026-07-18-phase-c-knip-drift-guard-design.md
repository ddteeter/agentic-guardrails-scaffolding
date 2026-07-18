# Phase C, piece 1 — knip integration + drift-guard harness

**Status:** design (approved to plan)
**Date:** 2026-07-18
**Phase:** C (TS pack complete + workspaces)
**Seeds:** `plan.md` §"Build phases" (C), §"Roadmap: fixer-loop hardening" (the
tool/language-upgrade drift-guard bullet), `guardrails-core/src/verify/`,
`guardrails-core/src/loose-rules.ts`, `guardrails-core/src/gate.ts`.

## 1. Why this is the first piece

Phase C's breadth adds four analyzers (knip, dependency-cruiser, semgrep,
stryker) plus affected-package scoping for workspaces. This piece takes the
**smallest analyzer** (knip) and pairs it with the **tool-upgrade drift-guard**
from the roadmap, because:

- knip is dependency-light, already loose-classed (`knip/` prefix is
  forward-declared in `loose-rules.ts`), and establishes the "add an analyzer to
  `verify`" pattern with the least surface area.
- The drift-guard's value is a direct function of hardcoded-id count, which
  jumps precisely in Phase C. `loose-rules.ts` already carries dangling `knip/`,
  `dependency-cruiser/`, and `stryker/` prefixes that reference tools not yet
  installed — latent drift sitting in the tree today. Building the guard while
  wiring analyzer #1 means every later analyzer is born guarded, versus
  retrofitting a guard onto four id-sets at once.

**Sequencing decisions this piece rests on** (settled in brainstorming):

- **AST auditor → deferred to Phase D.** Its urgency driver is Java Javadoc
  false-positives, it is a self-contained TS-compiler-API rewrite, and it
  unblocks no Phase-C analyzer. Its only Phase-C intersection (semgrep's
  structural matching overlapping the auditor) is a design note for the semgrep
  piece, not a reason to front-load a rewrite.
- **Copilot live-loop (carry-in #2) → parallel, off the critical path.** It is a
  manual VS Code/CLI acceptance test (`docs/copilot-live-loop-verification.md`)
  the developer runs when a session is handy; its precondition
  (`.github/hooks/guardrails.json` on the branch) is already met. It does not
  gate this design work.
- **Affected-package scoping → deferred.** The repo is a workspace
  (`workspaces: ['guardrails-core']`) but has a single member, so "affected" is
  always "all" — scoping has nothing to bite on until a second package exists.

## 2. Scope

**In scope**

1. A **verify profile** seam so the per-turn Stop gate stays fast while heavier
   analyzers run at lower-cadence gates.
2. A **knip adapter** mapping `knip --reporter json` into `Violation[]`, wired
   into `runVerify` at the commit rung.
3. A **drift-guard harness** (a hermetic test) covering every hardcoded id in
   `loose-rules.ts` via per-tool probes, with two probe strategies (knip +
   eslint-family) proving it generalizes.

**Out of scope** (each is a named follow-up, not a gap)

- Affected-package scoping (waits for a 2nd workspace member).
- The **throttled Stop tier** for whole-graph analyzers ("option B" below) — the
  fast-follow that makes knip's loose-classification live.
- **Baseline-diff snapshot** knip scoping ("option iii" below).
- The TS-compiler-API **AST auditor**.
- **audit.ts suppression-signature** drift (the drift-guard's documented next
  registry entry; untouched here because knip adds no suppression signatures).
- dependency-cruiser, semgrep, stryker.

## 3. Placement — the cadence ladder

Both `runStopGate` and `runCommitGate` already call the same `runVerify`; they
differ only in the auditor's diff baseline. That gives a ladder of **involuntary
gates**, each a superset of the one above:

| Rung       | Trigger                                                  | Cost budget               | Feeds fixer loop?                  |
| ---------- | -------------------------------------------------------- | ------------------------- | ---------------------------------- |
| **stop**   | every turn-end                                           | ~sub-second               | yes — delegate/recurrence/escalate |
| **commit** | every commit (Husky `pre-commit` + Copilot `preToolUse`) | seconds; local + blocking | no — hard-blocks                   |
| **ci**     | every push/PR                                            | minutes                   | no — authoritative backstop        |

The feedback mechanism is **not** asking the agent to run a heavier verify
(voluntary invocation is unreliable — the exact failure mode the loop exists to
avoid). Each analyzer binds to a forced gate chosen by its cost. **knip lands on
the commit rung**: whole-graph but seconds-scale, so every commit is a forced,
local, blocking trigger — frequent enough to catch dead code while it is fresh,
without taxing every trivial turn-end. (dependency-cruiser will join the commit
rung; semgrep is diff-scopable and may ride the stop rung; stryker is CI-only.
Those are later pieces.)

### 3.1 The commit gate stays block-only — and what that costs knip

The commit gate (`runCommitGate`) is deliberately block-only, not a delegating
loop, for three reasons:

1. **It is shared with agentless surfaces.** `runCommitGate` backs the Copilot
   `preToolUse` gate _and_ the git-native Husky `pre-commit` _and_ CI. A human
   `git commit` or a CI run has no agent, session, or fixer subagent to delegate
   to; a block is the only mechanism meaningful across all callers.
2. **Delegation is the Stop gate's job and the agent already gets it.** An agent
   blocked at the commit deny must still clear the Stop gate to end its turn,
   and that is where `decideGate` runs delegate/recurrence/escalate.
3. **A commit is not a turn.** `decideGate`'s attempt counter, model ladder, and
   snapshot lifecycle are per-session within-turn convergence state; bolting
   them onto a boundary that fires without an agent, at a different cadence,
   would be a second conflicting loop.

**Consequence, recorded explicitly:** under this cut, knip findings **block the
commit and the agent fixes them as ordinary work — they receive no delegation or
recurrence.** knip is loose-classed (`knip/` in `loose-rules.ts`), and that
routing to the _thorough_ fixer is **intentionally dormant** here, because the
only rung knip runs on does not delegate. This is consistent — the `knip/`
prefix was forward-declared before the tool existed — and the routing is
activated by the throttled Stop tier (option B), not by teaching the backstop to
delegate. Nobody should read the `knip/` loose entry as live behavior in this
cut.

## 4. Verify profile seam

`VerifyOptions` gains:

```ts
profile?: 'stop' | 'commit' | 'ci'; // default 'stop'
```

`runVerify` always runs ESLint (diff-scoped) + tsc (project-wide). knip runs
only when `profile !== 'stop'`. Callers:

- `runStopGate` → `profile: 'stop'` (knip does not run).
- `runCommitGate` → `profile: 'commit'` (knip runs).
- CLI `verify` command / CI → `profile: 'ci'` (knip runs).

**YAGNI:** this is a conditional, not an analyzer-registry abstraction. "Each
analyzer declares its minimum rung" is the right model for four analyzers, not
one — that refactor lands when dependency-cruiser (the 2nd commit-rung analyzer)
arrives. For now, one `if (profile !== 'stop')` branch around the knip dispatch.

## 5. knip adapter

New pure function, mirroring `parseEslintJson`:

```ts
// verify/knip-adapter.ts
export function parseKnipJson(
  stdout: string,
  repoRoot: string,
  packageId?: string,
): Violation[];
```

Unit-tested against captured `knip --reporter json` fixtures — no shell-out in
the unit test; the `runVerify` wiring is exercised through the injected `exec`
mock, as ESLint/tsc are today.

**Mapping** (knip groups findings by file; each file carries arrays keyed by
issue type — `files`, `exports`, `types`, `dependencies`, `unlisted`,
`duplicates`, `enumMembers`, …):

| Field      | Value                                                                                                               | Rationale                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ruleId`   | `knip/<issueType>`                                                                                                  | Lands under the existing `knip/` loose prefix.                                                                                                                                |
| `fixable`  | `false`                                                                                                             | knip `--fix` **deletes** exports/files/deps — collides with the loop's no-deletion principle; dead-code removal is a maybe-live judgment, never a silent PostToolUse autofix. |
| `severity` | `'error'`                                                                                                           | knip findings block the commit. (Uniform for the first cut; a per-issue-type severity map is a later refinement if `duplicates`-class noise warrants it.)                     |
| `line`     | present when knip supplies line/col (`exports`, `types`, `dependencies`); omitted for whole-file (`files`) entries. |
| `tool`     | `'knip'`                                                                                                            |                                                                                                                                                                               |
| `package`  | pass-through of `packageId`                                                                                         | Real per-package attribution is the affected-scoping work later.                                                                                                              |

**Scoping — project-wide, clean-baseline (option i).** knip is whole-graph: an
export in `A.ts` is dead because a _different_ file stopped importing it, so
findings land on files this commit may not have touched. Post-hoc filtering to
changed files (option ii) would discard exactly those cross-file findings — the
whole point of knip — and is rejected. Baseline-diff snapshotting (option iii)
is more precise but adds a snapshot lifecycle; it is the documented fast-follow
if project-wide noise proves annoying in dogfooding. For the first cut knip runs
project-wide and reports everything, **matching tsc's existing stance** (see the
`verify/index.ts` header: "`verify` assumes a clean type-check baseline"). The
same caveat is documented for knip.

**Enablement (first enable is a step, not a surprise).** knip needs a config
(`knip.json` or `package.json#knip`) declaring entry points, plus the devDep.
Because scoping is clean-baseline, the repo must be **knip-clean before the gate
relies on it** — this repo's own dead code surfaces on first enable. That is a
dogfooding feature (real findings), captured per the CLAUDE.md dogfooding
mindset, but the enablement sequence is: add config → run knip → clean existing
findings → wire into the commit gate.

## 6. Drift-guard harness

A **hermetic vitest test** in the existing suite (always-on locally and in CI,
catches manual dep bumps too, fails the build immediately on drift — the
"deterministic check" the roadmap prefers over an "upgrade agent"; Dependabot
targeting is a later optimization if the test proves slow).

**Shape — a registry of per-tool probes.** knip's ids are _not_ queryable the
way ESLint's are: ESLint plugins expose an enumerable rule registry, while
knip's issue types are a fixed enum baked into knip. So the guard cannot be one
uniform "ask the plugin for its rules" check — it is a registry:

```ts
interface DriftEntry {
  tool: string;
  knownIds: string[]; // what loose-rules.ts hardcodes
  probe: () => Promise<Set<string>>; // the tool's *current* id set
  hint: string; // file + what to fix on failure
}
```

The test iterates entries, runs each probe, and asserts every `knownId` is in
the probe's current set; a missing id fails with `hint`. Having **two
structurally different probes** from day one keeps the harness honest — a
single-entry registry would be a fake abstraction.

**Probes in this cut:**

- **knip** — extract knip's current issue-type set. Preferred: import knip's
  exported issue-type constant/union if it ships on a stable path; fallback: a
  golden fixture that trips every issue type, run `knip --reporter json`, read
  the emitted keys. Which one is used is settled at implementation against the
  installed knip version (a Copilot-SDK-types-style "is it exported on a
  supported path" check).
- **eslint-family** — enumerate the loaded plugins' rule keys and assert the
  loose _named_ rules (`expect-expect`, `no-trivial-assertions`,
  `assertions-in-tests`, `no-assertionless-test`, `no-restricted-imports`) and
  the `boundaries/` prefix still exist.

Both probes are hermetic (local tools/fixtures, no network).

**Coverage note.** This guards the id-existence half of `loose-rules.ts`. The
`LOOSE_PATTERNS` regexes (`archunit`, `pitest`, `descartes`) reference Phase-D
Java tools not yet installed; they register when the Java pack lands.
`audit.ts`'s suppression signatures are the harness's documented **next registry
entry** — untouched here because knip introduces no suppression signatures.

## 7. Testing (all TDD-first)

- `parseKnipJson` — unit tests over captured knip JSON fixtures: whole-file
  `files` entries (no line), per-file issue-type arrays (`ruleId` shape,
  `fixable: false`, line mapping), empty/malformed JSON (returns `[]`, mirroring
  `parseEslintJson`), `package` pass-through.
- `runVerify` profile gating — knip dispatched at `commit`/`ci`, skipped at
  `stop`, via the injected `exec` mock.
- `runCommitGate` / `runStopGate` — pass the expected profile; knip violations
  surface (and block) at the commit gate, are absent at the stop gate.
- Drift-guard harness — unit-test the registry-iteration/assert/hint logic
  against a fake probe (drift present → fails with hint; clean → passes), then
  wire the real knip + eslint-family entries.

## 8. Risks / open items

- **knip JSON shape** — the exact reporter schema is confirmed against the
  installed knip version at implementation; the mapping table (§5) is the
  contract, the field names are verified then.
- **knip issue-type export stability** — determines whether the drift probe is
  import-based or golden-fixture-based (§6). Resolved at implementation.
- **First-enable noise** — this repo's existing dead code blocks commits until
  cleaned (§5 enablement). Expected; it is the dogfooding signal.
- **Dormant loose-class** (§3.1) — a documented, intentional state, not a bug;
  activated by option B.
