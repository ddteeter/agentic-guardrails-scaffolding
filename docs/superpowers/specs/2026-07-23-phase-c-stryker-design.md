# Phase C, piece 4 — stryker (mutation testing), diff-scoped in the work cycle

The last analyzer in the TS pack. Unlike piece 3 (semgrep → no-go), stryker **ships
code**: a diff-scoped, incremental, commit-rung mutation check that asks the one
question nothing else in the pack answers — _the code you just wrote, do your tests
actually catch bugs in it?_

## 0. TL;DR (what this piece ships)

- **GO** — mutation testing is npm-native (`@stryker-mutator/core` +
  `@stryker-mutator/vitest-runner`), emits a formal versioned schema, and is the
  unique apex of the project's "don't let tests go hollow" premise. Every semgrep
  blocker is absent.
- Stryker runs **diff-scoped** (only the turn's changed files, reusing `verify`'s
  existing `changedTypeScriptFiles()`), **incremental** (warm re-run ~1s), at the
  **commit rung**, **blocking**, with **zero-tolerance on changed code**: any
  surviving mutant in changed code is a `stryker/survived` violation routed to the
  thorough fixer.
- It is **NOT** a whole-repo mutation-score gate. Whole-repo absolute thresholds are
  arbitrary; a per-change "your new code's mutants get killed" bar is principled and
  achievable, and it lives inside the agent work cycle instead of at CI's edge.
- The `ANALYZERS` table **graduates** to model a diff-scope policy (`scope`), the
  twice-deferred refactor that stryker finally forces. ESLint/tsc fold into the table.
- Noise is controlled **upstream** (diff-scope + consumer-owned `excludedMutations` +
  in-source region exclusion), never by tolerating survivors.

## 1. Why stryker, why it's a GO (and piece 3 wasn't)

Piece 3 retired semgrep because no reliable gate existed. Stryker is the opposite: the
tool is _right_, and it measures something no other pack member does. ESLint/tsc/knip/DC
all check the **code**; stryker checks the **tests** — a survived mutant is direct
evidence a test executes code without asserting on its behavior. That is the exact gap
the whole guardrail exists to prevent (the diff-auditor watches for removed assertions;
`vitest/expect-expect` catches assertionless tests; stryker is their apex).

Empirically confirmed this session (stryker 9.6.1, vitest-runner 9.6.1):

- **Installs/runs clean** on this repo — real npm packages, reproducible pin,
  auto-detects vitest. No pip/Docker (semgrep's blocker), no Pro-tier gating, no
  non-redistributable rules.
- **Report is the `mutation-testing-elements` schema** (`schemaVersion: 1.0`) — a
  formal, versioned, upstream-owned JSON schema, not proprietary ad-hoc output.

### The dogfood finding that shaped the design

A whole-repo run: **1629 mutants, 2m38s, 66.85% score, 441 survivors** — on a repo that
already passes strict ESLint + tsc + a coverage gate + `vitest/expect-expect`. Reading
every survivor with its source line:

| bucket                                | count | share | character                                                                                           |
| ------------------------------------- | ----- | ----- | --------------------------------------------------------------------------------------------------- |
| audit.ts hand-lexer branches          | 151   | 34%   | tokenizer state machine — exhaustive to kill, impl-detail                                           |
| `StringLiteral` in messages/labels    | 73    | 17%   | mutating human prose — brittle "assert exact wording" pressure                                      |
| defensive type-guard / nullish        | 46    | 10%   | the piece-3 parse-don't-validate boundary class                                                     |
| everything else (candidate real gaps) | 171   | 39%   | behavioral — but ~half contaminated (magic-number constants, exec-arg exactness, duplicate mutants) |

The genuine "your test is hollow, add an assertion" signal is real but a **minority
(~15–25%)**. These are **true positives** (unlike piece 3's false positives), but
mutation testing is inherently **threshold-based, never zero-tolerance** — 100% is not
the goal. So the design constraint is: **per-mutant-as-a-blocker on the whole repo is
the wrong _use_ of a right tool.** Emitting 441 blockers, or routing them to a fixer,
would push the agent to write brittle exact-message assertions and exhaustive lexer
tests to "kill" low-value mutants — the mutation-testing analog of piece 1's
trivial-assertion churn, a guardrail _degrading_ test quality.

The resolution (see §2) is **diff-scoping**: only ever mutate the agent's changed code,
where survivors are far more likely real, and the 441 whole-repo baseline is irrelevant.

## 2. The model: diff-scoped, incremental, in the work cycle

CI-whole-repo is the wrong frame — CI is outside the agent loop the project is about.
The levers that bring stryker in-loop, all measured this session:

| lever                                       | measured                                    |
| ------------------------------------------- | ------------------------------------------- |
| whole-repo                                  | 1629 mutants, 2m38s, 441 baseline survivors |
| scope to one changed file                   | 89 mutants (gate.ts), ~15s cold             |
| scope to a changed hunk (11 lines)          | 7 mutants, 2s, 3 survivors                  |
| `--incremental` warm re-run (no change)     | ~1s                                         |
| exclude noisy mutators (`StringLiteral`, …) | gate.ts survivors 36 → 20 (−44%)            |

`runStryker` mutates only the turn's changed files — the **same git-diff list**
`verify` already computes for ESLint/tsc scoping (`changedTypeScriptFiles()`). File-scope
turns 1629 → ~71/changed file; `--incremental` makes warm runs ~1s. That makes stryker a
**commit-rung** check (git pre-commit + CI) asking the genuinely agentic question, and it
**inverts the noise problem** — you only ever see mutants in the agent's new code, never
the 441 baseline (34% of which is the audit.ts lexer).

### Why a diff bar is principled, not vibes

Whole-repo absolute thresholds are arbitrary and the field knows it — stryker's own
defaults are `high:80 / low:60 / break:null` (break null by default). The recognized
principled practice is **threshold on _changed_ code** (the "diff coverage" philosophy
applied to mutation): new code should be killable; the legacy baseline is grandfathered.
"The handful of mutants in the code you just wrote should get killed" is achievable and
defensible; "the whole repo must hit 80%" is not. So the gate is **zero survivors in
changed code**, with no percentage anyone has to guess. Noise is handled upstream
(§4/§5), keeping the gate honest — never by tolerating survivors.

## 3. The analyzer registry graduation (the refactor)

Stryker is the first analyzer that is **both diff-scoped and carries a min-rung**:

| analyzer                 | scope             | rung       |
| ------------------------ | ----------------- | ---------- |
| ESLint                   | changed-files     | every rung |
| tsc                      | whole-project     | every rung |
| knip, dependency-cruiser | whole-project     | commit     |
| **stryker**              | **changed-files** | **commit** |

The current `ANALYZERS` table models only `minRung`; ESLint/tsc are a hardcoded
diff-scoped special-case outside it. Stryker doesn't fit either slot — which is exactly
the trigger the piece-2 note predicted would force graduation (re-deferred from semgrep
in piece 3). We graduate now:

```ts
type Scope = 'whole-project' | 'changed-files';
interface Analyzer {
  tool: string;
  minRung: Rung;
  scope: Scope;
  // changed-files analyzers receive the diff list; whole-project ignore it
  run: (
    o: VerifyOptions,
    resolveBin: (t: string) => string,
    files: string[],
  ) => Promise<Violation[]>;
}
```

ESLint and tsc fold into the table as entries (`eslint`: `changed-files`; `tsc`:
`whole-project`, min-rung `stop`), removing the `runEslintAndTsc` special-case. `runVerify`
becomes one uniform loop: for each analyzer at or above the active rung, run it, passing
the changed-file list. A `changed-files` analyzer that finds no changed files returns `[]`
early (preserving today's "no `.ts` changed → skip ESLint/tsc" behavior); `whole-project`
analyzers run regardless (preserving knip/DC's "run even on a `package.json`-only change").

This is a **behavior-preserving refactor** plus one new entry — done TDD-first, with the
existing verify tests as the regression net.

## 4. `runStryker` — consumer-generic invocation reading a report file

Two things make stryker's adapter shape differ from knip/DC, both handled in `runStryker`:

1. **It writes JSON to a file, not stdout.** `runStryker` forces the machine-readable
   reporter to a known path under the sandbox/temp dir (via `--reporters json` +
   `--jsonReporter.fileName`), execs stryker through the injected `Exec`, then reads that
   file and hands the contents to `parseStrykerJson`. Forcing the json reporter is
   output-format control (the same category as knip's `--reporter json`), **not**
   repo-policy — it does not touch the consumer's rules.
2. **It is diff-scoped.** `runStryker` passes the changed files as `--mutate`. Those paths
   come from the consumer's own `git diff` (not hardcoded), so the invocation stays
   consumer-generic — the piece-2 lesson. It passes `--incremental` for warm speed.

**Filter test files out of the mutate list.** `changedTypeScriptFiles()` returns _all_
changed `.ts` (production and tests) — correct for ESLint/tsc, wrong for `--mutate`, which
must target **production** code (mutating a test file is meaningless). `runStryker` drops
test files (`*.test.ts` / `*.spec.ts` — near-universal naming; a repo-configurable test
pattern is a forward-link, not first-cut). If the filtered list is empty (a tests-only
turn), `runStryker` returns `[]`, exactly like the no-`.ts`-changed path.

Everything else is the consumer's: **no `--configFile`** (stryker auto-detects the
consumer's `stryker.conf.json`, exactly as DC/knip auto-detect theirs), no repo-specific
target. A **"no repo-specific argv" test** asserts the argv carries only the changed-file
mutate list + output/incremental flags — no `guardrails-core`-shaped paths, no `--config`.

**CLI `--mutate` replaces config `mutate`** (verified: CLI wins, config mutate dropped).
That is fine and intended — diff-scoping _is_ the mutate set. Its consequence for region
exclusion is handled in §5.

Cold-start: a fresh clone/CI has no incremental cache, so the first run pays full cost —
but it is already changed-file-scoped (bounded), and warm local runs are ~1s. The cache
is gitignored (`.stryker-tmp/`, the incremental file, stryker reports); committing a
large, machine-sensitive, drift-prone cache onto a gate is an anti-pattern.

## 5. `parseStrykerJson` adapter

Maps the `mutation-testing-elements` report → `Violation[]`, scoped to changed files:

- Input: parsed report + the changed-file list (so a `whole-project` cold incremental
  build can't leak baseline survivors from untouched files). Iterate `files[path].mutants[]`
  for `path ∈ changedFiles`.
- Emit a violation **only for `status === 'Survived'`**. `Killed`/`Timeout` are good;
  `Ignored`/`Pending`/`CompileError`/`RuntimeError` are non-signal; **`NoCoverage` is
  deliberately left to the coverage gate** (fallow), mirroring piece 2's "don't
  double-own dead-code" (orphan/unresolved left to fallow+knip).
- Shape: `{ ruleId: 'stryker/survived', file: path, line: mutant.location.start.line,
message: \`${mutatorName} mutant survived — a test executes this line but doesn't assert
  its behavior\`, severity: 'error', fixable: false, tool: 'stryker' }`(+`package`when
set).`fixable:false` — the fix is a judgment (strengthen a test, or exclude an
  equivalent mutant), never a silent autofix.
- `mutatorName` is carried into the message but is **not** a classification key — the
  schema documents it as free-form ("Category of the mutation"), so the adapter keys only
  on `status`.
- `stryker/survived` is already loose via the `stryker/` prefix in `loose-rules.ts` — no
  change there. The loose-class routing to the thorough fixer is now **live** (commit-rung,
  blocking, on a small diff), not dormant like knip/DC, and correctly so: a survived mutant
  in new code is a "green fix can be far from a good one" case (a lazy assertion kills the
  mutant without testing the behavior).

## 6. Drift-guard entry — the fourth probe, over the status enum

The adapter classifies on `MutantStatus`. That enum is the honest, upstream-owned drift
target — and it is the **cleanest of the four probes**: the schema package
(`mutation-testing-report-schema`) **publicly exports** the JSON schema as a subpath
(`mutation-testing-report-schema/mutation-testing-report-schema.json`), so the probe reads
the enum via a supported public import (no fixture like knip, no internal-file bypass like
DC):

```ts
const schemaPath =
  require.resolve('mutation-testing-report-schema/mutation-testing-report-schema.json');
// walk the schema, collect the MutantStatus enum → Set<string>
```

`knownIds` = the statuses the adapter depends on: at minimum `Survived` (the one it emits
on) plus the statuses it explicitly classifies as non-violations (`Killed`, `Timeout`,
`NoCoverage`) so a rename of any of them surfaces. `mutatorName` is **not** asserted (free-form,
not an enumerable set). Hint points at `stryker-adapter.ts`. `mutation-testing-report-schema`
is declared as a direct devDependency of `guardrails-core` (it is currently transitive via
stryker — the same "declare in the workspace that uses it" lesson as piece 1's `@eslint/js`).

## 7. Dogfooding config on this repo

- **`stryker.conf.json`** (committed, this repo's own — like `knip.json` /
  `.dependency-cruiser.cjs`): `testRunner: 'vitest'`, `reporters: ['json']`,
  `mutator: { excludedMutations: ['StringLiteral'] }` (the biggest brittle-assertion noise
  source; consumer-owned and trivially overridable — the scaffolder ships this as a template
  in Phase E), `incremental: true`. It lives outside any tsconfig → add to the ESLint global
  `ignores` alongside the other tool configs (the piece-2 lesson).
- **audit.ts region exclusion** via **in-source `// Stryker disable all` / `// Stryker
restore all`** around the tokenizer helpers (`isQuoteChar`…`skipRegexFlags`, ~L160–393),
  **not** config mutate-ranges. Verified this session: config range-negation is fragile
  (excluded the whole file → 0 mutants) _and_ is clobbered by CLI `--mutate`; in-source
  disable directives compose with `--mutate` (the disabled line's mutants go `Ignored`) and
  are edit-robust (move with the code). The higher-level diff-parsing logic (`parseDiff`,
  hunk handling) stays mutated. Rationale (a written justification, per the "curated, not
  reflexive" bar): a hand-written lexer is mutation-dense in boundary/equivalent mutants
  with poor defect-catching ROI, and its behavioral security tests (does a diff adding
  `eslint-disable` get flagged?) already exist and are the real coverage.
- **devDependencies:** `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`,
  `mutation-testing-report-schema` (real install; the session's `--no-save` pre-flight is
  replaced by proper `devDependencies`).
- **gitignore:** `.stryker-tmp/`, the incremental file, the json report path.

## 8. Testing (all TDD-first)

- **`parseStrykerJson`**: fixture-driven (a captured real report). Survived-in-changed-file
  → violation; Killed/Timeout/Ignored/NoCoverage → none; survivor in an _unchanged_ file →
  none (scope guard); malformed JSON / wrong shape → `[]` (mirrors knip/DC guards);
  `fixable:false` pinned via object-equality (the piece-1 `no-unnecessary-boolean-literal-compare`
  lesson); whole-array matchers (`toContainEqual`) to dodge `noUncheckedIndexedAccess`
  (the piece-2 vitest-hid-the-tsc-error lesson).
- **`runStryker` argv**: mock `Exec`; assert the argv carries the changed-file mutate list +
  json-reporter + `--incremental` and **no** `--config`/repo-specific path (the "no
  repo-specific argv" test). Assert it reads the configured report path and returns the
  parsed violations.
- **Registry graduation**: existing verify tests are the regression net; add tests for the
  `scope` dispatch (changed-files analyzer skipped when no `.ts` changed; whole-project
  analyzer still runs; rung gating unchanged).
- **Drift probe #4**: the enum probe returns a set containing the asserted statuses against
  the installed schema.
- **Verify against the real gate** (`npm run lint`, `npm test`, `npm run typecheck`,
  `npm run check:graph`) — never a hand-scoped probe (the piece-3 false-negative lesson).

## 9. Findings to record in plan.md

- **Registry graduation resolved** — the twice-deferred (semgrep→stryker) `ANALYZERS`
  abstraction now models `scope`; ESLint/tsc folded in.
- **`// Stryker disable` is in-source checker-weakening**, and audit.ts _is_ the
  suppression-detector — so the diff-auditor (`audit.ts`) should likely watch `// Stryker
disable` as a suppression signature. Follow-up (Roadmap: fixer-loop hardening / audit
  suppression list).
- **Mutation testing has poor ROI on hand-written parsers** (audit.ts: mutator-exclusion
  only cut it 31% because the residue is control-flow mutators you can't drop) — curation
  guidance for the pack: exclude mutation-hostile files/regions deliberately, in-source.
- **Whole-repo absolute mutation thresholds are arbitrary**; diff-scoped zero-tolerance is
  the principled, in-work-cycle model. Informs any future product framing of stryker.

## 10. Out of scope / forward-links

- **Hunk-range scoping** (`file:start-end` from `git diff -U0`) — tighter than file-level
  (single-digit mutants/turn) but needs a diff-hunk parser + tests. Deferred; file-level
  (reusing `changedTypeScriptFiles`) is the first cut.
- **Whole-repo mutation-score ratchet at CI** — an optional backstop (baseline score,
  never-regress). Not shipped; the per-turn diff gate is the value.
- **Stop-rung stryker** for tiny diffs — possible once throttling exists, but a turn
  touching a big file is ~15s+, so commit-rung is the prudent home.
- **Scaffolder template** (the recommended `stryker.conf.json` + `excludedMutations`
  default) — Phase E, consistent with the consumer-owned-config decision.

### Known boundary (by design, not a gap)

Diff-scoping to changed **production** files means a turn that _weakens a test_ on
**unchanged** production code won't be caught by stryker (the production file isn't in
`--mutate`, so the newly-surviving mutant isn't re-tested). That is the **diff-auditor's**
job — it watches for removed/loosened assertions directly. Stryker owns "new production
code arrived under-tested"; the auditor owns "an existing test got weaker." Complementary,
not overlapping — and calling out the seam here prevents a future "stryker missed it"
false finding.
