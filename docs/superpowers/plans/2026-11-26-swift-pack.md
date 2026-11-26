# Plan — the Swift pack, first half (GR-01, GR-02, GR-03, GR-04, GR-14)

Design: `docs/superpowers/specs/2026-11-26-swift-pack-design.md`. Open
questions: `QUESTIONS.md`. Branch: `sprint/swift-pack`, from `53b24da`
(guardrails-core 0.19.0).

Every step is test-first and green on its own. After a change under
`guardrails-core/src/`, `npm run build` before trusting a gate. No
suppression, no sanction, no golden edit after step 1.

## Environment notes for whoever runs this

- Node 24 is required (`engines`, `engine-strict`).
- The suite assumes an ordinary developer machine: run as root, eight
  permission tests cannot fail closed (`chmod 000` is ignored), and a global
  `NODE_PATH` that provides `typescript` breaks three "no typescript
  installed" tests. Neither is a defect of `main`; both are recorded in
  `QUESTIONS.md` as a finding about the suite's portability.

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

1. `verify/analyzer.ts`: the `Analyzer`, `VerifyOptions`, `VerifyResult`
   types, moved and re-exported. No test change.
2. `packs/pack.ts`: `StackPack`, `StackConfig`, `StackContext`.
3. `packs/typescript.ts`: the three file predicates move here from
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

_Filled in as the commits land._

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
