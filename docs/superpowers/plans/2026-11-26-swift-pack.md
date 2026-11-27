# Plan — the Swift pack, first half (GR-01, GR-02, GR-03, GR-04, GR-14)

Design: `docs/superpowers/specs/2026-11-26-swift-pack-design.md`. Open
questions: `QUESTIONS.md`. Branch: `sprint/swift-pack`, from `53b24da`
(guardrails-core 0.19.0).

Every step is test-first and green on its own. After a change under
`guardrails-core/src/`, `npm run build` before trusting a gate. No
suppression, no sanction, no golden edit after step 1.

## Environment notes for whoever runs this

- Node 24 is required (`engines`, `engine-strict`).
- The suite used to assume an ordinary developer machine: run as root, seven
  permission tests could not fail closed (`chmod` is ignored), and a global
  `NODE_PATH` that provides `typescript` broke four "no typescript installed"
  tests. Fixed on this branch on the owner's decision (see the verification
  log and `QUESTIONS.md` entry 7); the suite now passes in both environments.

## 0. Documents

- [x] The design and this plan, committed first.
- [ ] `QUESTIONS.md` at the repository root, started with the brief's six
      questions, appended to as the work raises more.

## 1. GR-01 — parity goldens

1. `test/parity/fixture.ts`: materialise a fixture descriptor into a temporary
   git repository (`main` with the base files committed; a `work` branch with
   the change staged), with `GIT_*` stripped from the environment and a
   `node_modules` symlink. Unit-tested without any analyzer.
2. `test/parity/normalise.ts`: the fixture path (and its realpath) to
   `<root>`, and nothing else. Unit-tested on literal strings.
3. `test/parity/run.ts`: run one command through `runCommand` with real
   `spawnExec`, capture exit code, stdout, stderr.
4. The fixtures (`test/fixtures/parity/*.json`): `clean`, one per analyzer,
   one per audit kind, `sanctioned`, `outside-source`.
5. `test/parity.test.ts`: every fixture and command against its golden;
   `PARITY_RECORD=1` records; a missing golden fails; the golden set equals
   the fixture-and-command set. Stands down under mutation.
6. Record the goldens at the branch base, before any change under `src/`.
7. Verification, done by hand and recorded here: change one adapter's message,
   see the suite fail, revert.
8. `guardrails-core/docs/releasing.md`: the consumer parity procedure.

## 2. GR-02 — the pack seam

1. `packs/pack.ts`: `StackPack` (generic in its analyzer type, so no type
   has to move out of the orchestrator), `StackConfig`, `StackContext`.
2. `packs/stacks.ts`: the implicit stack, `stackOf`, `perStack`, `packOf`.
3. `packs/typescript-files.ts`: the three file predicates move here from
   `verify/git.ts`; tests change import paths only (list below).
4. `typescriptPack(analyzers)` and the registry; `selectAnalyzers` reads the
   pack's table; `missingToolViolation` takes `pack.installHint`;
   `runAutofix` goes through `pack.autofix`; package attribution through
   `pack.ownerOf`; related tests through `pack.coveringTests`.
5. `config.ts`: `pickStacks` with the implicit default, per-entry warnings,
   root normalisation, per-pack `wholeProjectTrigger` default, the Swift keys.
6. `upgrades/unreleased.md`: "no action".
7. Verification: the full suite, the goldens, Stryker on the changed lines.

Test files touched by the seam (import paths only):

- `guardrails-core/test/verify/git.test.ts`: `isConfigFile`, `isTestFile`
  and `isTypeScriptFile` are imported from `src/packs/typescript-files.js`
  instead of `src/verify/git.js`. Nothing else in the file changed.

No other existing test was edited for the seam. Four files gained tests and
changed no existing one: `test/config.test.ts` (`stacks` parsing),
`test/covering-tests.test.ts` (`coveringTestsFinder`, `withRelatedTests`),
`test/autofix.test.ts` (routing across stacks) and `test/parity.test.ts`
(the explicit-stack run). New files: `test/packs/stacks.test.ts`,
`test/packs/typescript.test.ts`, `test/verify/stacks.test.ts`,
`test/cli-stacks.test.ts`.

## 3. GR-03 — multi-stack scoping

1. `packs/stacks.ts`: `stackOf(file, stacks)` (longest root, `exclude`),
   `partitionByStack`.
2. `changedFiles` returns every changed file; each stack filters with its
   pack. TypeScript's list is unchanged (test).
3. `selectAnalyzers` per stack; `wholeProjectTrigger`; ci always runs
   whole-project analyzers.
4. `VerifyOptions.stacks`, `.packs`, `.stack`; `guardrails/stack-unsupported`.
5. `Violation.stack`, stamped only when `stacks` is configured.
6. `--stack=<id>` on `verify` and `gate --mode=ci`; unknown id exits 2.
7. Tests: a dummy second pack; web-only and second-stack-only diffs; a
   TypeScript-only `stacks` block reproduces the goldens; no Swift stack
   selects zero Swift analyzers.

## 4. GR-04 — the Swift lexer and auditor rows

1. `src/swift-lexer/`: the lexer, test-first, 100% mutation score, no
   suppression (`test/swift-lexer.test.ts`).
2. `audit.ts`: the per-extension lexer table beside the JavaScript lexer
   (whose sanctioned region is not moved or reworded); `languages` on
   `Signature`; `.swift` auditable; lexer state carried across the lines of a
   hunk; optional `readSource` for the state at a hunk's first line.
3. The rows, one at a time (`test/audit-swift.test.ts`), each with a positive
   case, the non-match contexts and the interpolation match.
4. `force-unwrap` as a token rule.
5. `pkg` rows for `Package.swift` and `project.yml`.
6. `tool-config-escape` for `.swiftlint.yml`, `.swiftformat`,
   `.periphery.yml`.
7. `debugTargets` exemption for `compile-escape`.
8. `DENIED_FILE_NAMES`.
9. Opt-in tests: no Swift row matches a `.ts` file; no existing row matches a
   `.swift` file; goldens unchanged.

## 5. GR-14 — the mutation generator

1. `.dependency-cruiser.cjs`: `swift-mutate-is-standalone`, with a test that
   a forbidden import is reported.
2. `src/swift-mutate/generate.ts`: tokens in, mutants out; range
   intersection; the disable directive; locations.
3. `src/swift-mutate/operators.ts`: the seventeen operators, one at a time.
4. Stryker at 100% on `src/swift-mutate/**`.

## Not this lane

GR-05 to GR-13 and GR-15 to GR-20: the releases, the consumer's bumps, the
Swift tool adapters, the runner's sandbox loop, the app build, `init`
detection for Swift, the tripwires. What they need from the owner is listed
in `QUESTIONS.md`.

## Verification log

### GR-01

- Environment check on a clean `main` (`53b24da`), Node 24: `npm ci`,
  `npm run build`, `npm run typecheck`, `npm run lint` exit 0; `npm test`
  115 files, 4,264 tests passed (with the two environment conditions in
  `QUESTIONS.md` entry 7 removed).
- Goldens recorded at `53b24da` with no change under `src/`: 20 fixtures,
  four commands each. Replayed twice with identical results.
- Cost: the parity suite takes about 23 s of wall-clock time on the cloud
  machine (about 60 s of CPU), real Stryker run included, with fixtures run
  five at a time.
- Step 7, by hand: `'Unused file'` changed to `'Unused file!'` in
  `verify/knip-adapter.ts`; `parity.test.ts` failed on the `knip` fixture,
  naming the changed message in both the printed line and the manifest;
  reverted.

### GR-02 and GR-03 (commit `de1e2f7`)

- One commit for both: their hunks interleave in `verify/index.ts`
  (`selectAnalyzers` and `runVerify` are where the seam and the scoping
  meet), and splitting them would have left an intermediate commit whose
  `runVerify` was neither.
- Full suite: 123 files, 4,470 tests. `tsc`, ESLint, knip, dependency-cruiser
  clean.
- Parity: all 20 goldens unchanged, and unchanged again with an explicit
  TypeScript-only `stacks` block (the `stack` stamp aside; the test counts
  the stamps).
- Commit gate, first attempt: blocked. 15 surviving mutants out of 1,374 on
  the changed lines, and four duplication findings. Fixed in code and tests,
  none suppressed:
  - `perPack` in `packs/stacks.ts` replaced three `packOf(…)?.method` call
    sites whose optional chain no test distinguished;
  - `noFiles()` replaced seven `{ files: [], … }` returns in `changedFiles`,
    which had been killable only while the list was filtered at source;
  - `repoRelative` was a copy of `timeout-meter.ts`'s: one shared module now;
  - `verifySettingsOf` and `stackAwareContext` in `cli-core.ts` replaced
    three field-by-field config mappings and two preambles;
  - tests added for the default `resolveBin`, a missing pack in `autofix`,
    package attribution of an audit finding through the gate, an empty
    `stacks` list, a failed git listing, and a whole-project analyzer in
    `isAnalyzerSelected`.
- Commit gate, second attempt: passed (1,494 mutants in scope, none
  surviving).
- Two dogfooding findings recorded in `plan.md` ("Roadmap: fixer-loop
  hardening"): the fixer agents are not loadable in a session that starts
  before the first build, and `dupes` paired two unrelated interfaces.

### GR-04

- The lexer (`src/swift-lexer/`, eight files, about 740 lines) was built
  test-first by a delegated agent in its own worktree against a written
  contract, then reviewed and copied in: 312 tests, including a seeded
  robustness run (3,000 pseudo-random lines threaded through the state,
  asserting termination and that every character lands in exactly one
  token). Its Stryker run over `src/swift-lexer/**`: 331 mutants, 262 killed,
  19 timeouts (infinite-loop mutants of the main loop), 0 survived, 0
  without coverage, 50 ignored (the repository's `StringLiteral` exclusion).
  No suppression. Its documented limits are in `swift-lexer/index.ts` and
  pinned by tests.
- The rows: `test/audit-swift.test.ts` holds every code row to the matrix
  (code and interpolation are findings; line comment, doc comment, nested and
  multi-line block comment, string, multi-line string, raw string and
  backtick identifier are not) and every directive row to its own; plus the
  precision cases, the test-target and debug-target scopes, the settings
  rows, the hunk-state cases and the two opt-in guarantees.
- `audit-swift.ts`, `audit-tool-config.ts` and `audit.ts` under Stryker:
  first run 37 survivors (whitespace variants of the patterns, and seven
  structural mutants no input could tell apart). Samples added for the
  first kind; the second kind redesigned away (rows carry a scope instead of
  being spread conditionally; the readers take one argument, not a line and
  an `isAdded` flag whose answer the caller discarded; the tool-config
  lookup has no default branch to empty). Second run: 416 killed, 0
  survived, 390 ignored (`StringLiteral`, and the JavaScript lexer's
  sanctioned region, which was not moved or reworded).
- Full suite: 126 files, 5,416 tests. Goldens unchanged.
- `swift-mutate-is-standalone` and `swift-mutate-entry-points` added to
  `.dependency-cruiser.cjs` with the lexer, since the lexer is inside the
  boundary. By hand: a probe file in `src/swift-lexer/` importing `../exec.js`
  made `npm run depcruise` fail with
  `error swift-mutate-is-standalone: …/zz-probe.ts → …/exec.ts`; removed.

### GR-14

- Built by the same delegated agent on its lexer, against a written brief
  (the API, the seventeen operators, the rules that keep a mutant
  well-formed, the test matrix), then copied in and checked here: `tsc`,
  ESLint, knip, dependency-cruiser (both boundary rules) and `fallow dupes`
  clean; 645 tests in `test/swift-mutate.test.ts` and
  `test/swift-mutate-structure.test.ts`.
- Its Stryker run over `src/swift-mutate/**`: 1,026 mutants, 824 killed, 1
  timeout, 0 survived, 0 without coverage, 201 ignored (`StringLiteral`). No
  suppression. The lexer was not changed.
- Spot check by hand: a 19-line Swift file through `generateMutants`, each
  mutant applied and read. 35 mutants; none in the doc comment or in string
  text; the interpolation mutated; `Array<Int>` untouched; the
  comma-separated `guard` left alone by `GuardNegation`; the
  `disable-next-line` directive marking exactly its operator `Ignored`.
- Rules the agent added beyond the brief, each tested: `==` between two
  capitalised names is a generic constraint and is skipped; an infix swap
  directly after `func` or `operator` is a declaration and is skipped; `+`
  and `+=` with a string literal or `[` operand are concatenation and are
  skipped; `repeat … while` is skipped; macro lines and macro arguments are
  excluded with compiler directives. `.first(where:)` ↔ `.last(where:)` is
  not built (`last(where:)` needs a bidirectional collection).
- Known limits, in `swift-mutate/index.ts` and the tests: with no types, `a +
b` over two string variables still becomes `a - b`, and `.first` on a
  `Set` still becomes `.last`; both fail to compile and would count toward
  the compile-error tripwire.
- The six infix swap tables were first written as strings, which this
  repository's Stryker config does not mutate. On the owner's decision they
  are now data (`swap-tables.ts`, one `[from, to]` direction per entry): 29
  array mutants and 6 block mutants there, all killed, and no clone reported,
  so no `duplicates.ignore` entry was added.

### The branch as a whole (head of the lane)

- `npm run typecheck`, `npm run lint`, knip, `npm run depcruise`: clean.
- The pre-push hook's three steps, run by hand because the remote refused
  the push itself (see the hand-off):
  - `gate --mode=push`: passed. 3,294 mutants on the branch's changed lines,
    none surviving; a handful of timeouts, each re-tested alone and kept as
    killed, as the gate does.
  - `npm run test:coverage`: 128 files, 6,061 tests, 99.7% of statements and
    lines.
  - `npm run check:graph`: 0 above threshold.
- One flake seen, twice in four full-suite runs:
  `drift/stryker-timeout.test.ts` ("blocks nothing, cold or seeded") asserts
  that no mutant of its fixture needs a timeout retest, with a one-second
  `timeoutMS`. With five parity fixtures running real tools at once on a
  four-core machine, one did. It passes alone and in a quiet full run. The
  parity suite now runs two fixtures at a time (`FIXTURES_AT_ONCE`).
- Parity suite cost after that change: recorded in `QUESTIONS.md` entry 4.

### Decisions taken with the owner after the first hand-off (2026-11-27)

- `guardrails/stack-unsupported` is an error, not a warning (`41300b9`).
- The Swift Testing trait rows stay scoped to test-target paths.
- The parity suite stays in `npm test`.
- A golden may change with `package-lock.json` alone
  (`docs/releasing.md`).
- The generator's swap tables are data, with no duplication ignore.
- The 11 environment-dependent tests are fixed on this branch (entry 7).
  Existing test files changed for that, and for nothing else:
  `test/gate-run-log.test.ts`, `test/run-log.test.ts`, `test/ship.test.ts`,
  `test/repo-source.test.ts`, `test/typescript-loader.test.ts`,
  `test/import-graph.test.ts`, `test/gate.test.ts`. Verified by running the
  whole suite twice, as root with `NODE_PATH` set and through the
  ordinary-user wrapper: 128 files, 6,061 tests, both green.
- `'java'` is not reserved as a pack id; the un-anchored SwiftLint and
  SwiftFormat rows, the split of the Swift rows into their own file, and the
  deferral of the import-rules and runner-config escape rules all stand.
