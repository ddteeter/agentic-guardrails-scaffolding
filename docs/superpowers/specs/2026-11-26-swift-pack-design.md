# The Swift pack, first half — design

## Problem

guardrails-core gates a TypeScript repository. The first consumer is about to
grow an iOS app in the same repository (`ios/`), and its Swift code has to be
held to the same deterministic gates as the web app: lint, types, tests, dead
code, architecture, suppression audit, mutation testing. guardrails-core is
TypeScript-specific in a handful of places (which files are source, which
analyzers exist, how a line is lexed for the auditor), so the Swift pack needs
a seam first, and the seam must change no verdict a TypeScript consumer gets
today.

This document covers the half of the pack that runs on Linux and needs no
Swift toolchain. The Swift tool adapters, the mutation runner's sandbox loop
and the app build need macOS and Xcode and are a later lane.

## Scope

In this branch, in this order:

| id    | what                                                                   |
| ----- | ---------------------------------------------------------------------- |
| GR-01 | verdict-parity goldens and `test/parity.test.ts`                       |
| GR-02 | the `StackPack` seam, the TypeScript pack behind it, `stacks` parsing  |
| GR-03 | multi-stack scoping, `--stack`, `wholeProjectTrigger`                  |
| GR-04 | the Swift lexer and the Swift auditor rows                             |
| GR-14 | the `swift-mutate` generator and operators (lexer-based, no toolchain) |

Out of scope: a release, a version bump, a tag; any edit to this repository's
own sanctions; the consumer parity run (it needs the consumer's repository);
anything that needs macOS; a Java pack; and any change to a web verdict.

Open questions for the owner are in `QUESTIONS.md` at the repository root.
Where this document says "the owner decides", the branch does the stated
default meanwhile.

## What changed since the plan was written

The plan was written against guardrails-core 0.14.2. This branch starts from
0.19.0 (`53b24da`). Three consequences:

- **Release numbers.** The plan's 0.15.0 to 0.19.0 are taken. This document
  names releases by content: _the seam release_ (GR-01 to GR-03), _the Swift
  lexer release_ (GR-04), _the adapters release_ (GR-07 to GR-11), _the runner
  release_ (GR-14 to GR-16). The owner assigns numbers when cutting them.
- **The parity baseline is the branch base, 0.19.0**, not 0.14.2. The claim the
  goldens support is "no later build differs from today's", and today is
  0.19.0.
- **The TypeScript-specific surface is larger than the plan listed.** 0.15 to
  0.19 added the `complexity` and `npm-peers` analyzers, the mutation cache
  (`prepare-cache.ts`, `importing-tests.ts`, `enclosing-spans.ts`,
  `verdict-dependencies.ts`), `ship.preflight` and `guardrails lock`. The
  re-survey is in "The TypeScript-specific surface" below.

Java is already named in this repository (`audit.ts` carries Java signatures
and `.java` is auditable; `plan.md` lists a Java pack as Phase D, not built).
This branch builds no Java pack and leaves every Java row exactly as it is.
`StackPackId` is a union that a later pack extends by one member; whether to
reserve `'java'` now is a question for the owner.

## GR-01 — verdict-parity goldens

### What a golden is

A golden is the normalised output of one guardrails command run against one
fixture repository with the **real analyzers**: its exit code, stdout,
stderr, and every violations manifest it left in the state directory (the
printed lines do not carry a violation's package, related tests or guidance;
the manifest a fixer is pointed at does). Four commands are recorded per fixture, because GR-02 and GR-03 touch
all four paths (config loading, analyzer selection, the auditor, and the
`--stack` flag):

| command              | rung   | change set seen by analyzers |
| -------------------- | ------ | ---------------------------- |
| `gate --mode=commit` | commit | staged                       |
| `gate --mode=push`   | push   | branch diff                  |
| `gate --mode=ci`     | ci     | branch diff                  |
| `verify`             | ci     | branch diff, no auditor      |

Each command runs in a **fresh copy** of the fixture, so no rung reads state
another rung wrote (the push rung remembers a passing tree, and the gates
write manifests).

The commands run through `runCommand` from `cli-core.ts` with real
`spawnExec`, so the golden covers the whole path a consumer's hook takes:
config file, option mapping, git, analyzer spawn, adapter, auditor, sanction
budget, verdict and exit code.

### Fixtures

A fixture is one JSON file under `guardrails-core/test/fixtures/parity/`:

```jsonc
{
  "description": "one sentence",
  "base": { "<path>": "<content>" }, // committed on main
  "change": { "<path>": "<content>" }, // staged on a work branch, not committed
}
```

Files are stored as JSON strings rather than as files on disk, for two reasons
that both come from this repository gating itself:

- the diff auditor reads `.ts` files added in a commit, so a checked-in
  fixture that contains a real `eslint-disable` would block the commit that
  adds it, and the only way past would be a sanction this lane may not add;
- a fixture directory with its own `package.json` and configs would have to be
  excluded by hand from this repository's tsconfig, ESLint, knip and fallow
  (the four-way exclusion the knip drift fixture already needs), and would be
  copied into Stryker's sandbox.

At test time the fixture is written to a temporary directory, `git init`-ed
with `main` as the base branch, and given a `node_modules` symlink to this
repository's, which is how the drift guards already run real tools.

The fixture set:

- `clean` — a change with no violation, with ESLint, tsc, knip,
  dependency-cruiser, dupes and complexity all required (Stryker and
  npm-peers run in their own fixtures only: the first for cost, the second
  because its answer would otherwise depend on this repository's install);
- one per analyzer with exactly one violation: `eslint`, `tsc`, `knip`,
  `dependency-cruiser`, `stryker`, `dupes`, `complexity`, `npm-peers`;
- one per existing audit kind: `eslint-disable`, `ts-suppress`, `cast-any`,
  `suppress-warnings`, `disabled-test`, `skipped-test`, `mutation-suppress`,
  `analyzer-ignore`;
- `sanctioned` — a suppression covered by a `sanctionedSuppressions` entry;
- `outside-source` — a change that touches no source file (a `README.md`);
- `workspace` — a violation inside a workspace member, so the manifest
  carries the owning package.

Every fixture pins its `analyzers` block explicitly, so each golden exercises
what its name says and the suite's cost stays bounded: audit fixtures turn
every analyzer off, analyzer fixtures run only their own. Stryker runs in one
fixture only (two functions: one whose mutants are all killed and one with a
survivor), which keeps the real mutation run to four invocations.

### Normalisation

Only what cannot be stable is rewritten: the fixture's temporary path (also in
its `realpath` form) becomes `<root>`. Nothing else is touched; message
text, rule ids, ordering and counts are compared exactly. No recorded output
holds a duration, so none is masked: a mask nobody exercises is a place for a
real difference to hide.

### The rule

`test/parity.test.ts` re-runs every command and compares with the golden on
every build. **No later change may edit a golden.** A golden changes only in
its own owner-approved pull request that names the behaviour change. Goldens
are re-recorded with `PARITY_RECORD=1`; without it a missing golden fails.
A second test fails when the set of golden files and the set of
fixture-and-command pairs differ, so a fixture cannot be dropped silently.

Two limits, stated rather than hidden:

- **Goldens include tool output.** An ESLint or TypeScript upgrade that
  rewords a message changes a golden without any guardrails behaviour change.
  That is a second legitimate reason to re-record, and it is distinguishable:
  such a commit changes `package-lock.json` and nothing under `src/`. Whether
  that is acceptable or the tool text should be masked is the owner's call.
- **The suite stands down inside this repository's own mutation run**, through
  `describeUnlessMutating`, like the drift guards and for the same reason
  (nested Stryker and ESLint do not start inside Stryker's sandbox). It
  therefore kills no mutant; the unit tests of each package do that.

### Consumer parity

`guardrails-core/docs/releasing.md` gains the consumer procedure: at one
pinned commit of the consumer, run each rung with the previous tarball and the
candidate, normalise both the same way, and require an empty diff. Running it
is not this lane's.

## GR-02 — the pack seam

### The interface

```ts
// guardrails-core/src/packs/pack.ts
export type StackPackId = 'typescript' | 'swift';

export interface StackPack<Analyzer extends PackAnalyzer = PackAnalyzer> {
  id: StackPackId;
  isSourceFile(file: string): boolean;
  isTestFile(file: string): boolean;
  isConfigFile(file: string): boolean;
  analyzers: readonly Analyzer[];
  isProviderDeclared(
    stack: StackConfig,
    provider: string,
    manifest: ReadonlySet<string>,
  ): boolean;
  installHint(provider: string): string;
  autofix(run: StackRun, files: string[]): Promise<void>;
  ownerOf(context: StackContext): (file: string) => string | undefined;
  coveringTests(
    context: StackContext,
  ): (file: string) => readonly string[] | undefined;
}
```

Everything else stays generic: the `Violation` contract, the rungs,
`selectAnalyzers`, the gate, state, sanctions, hooks, the fixer ladder, `ship`.
`Violation` gains one optional field, `stack`. Recurrence keys stay
`package:ruleId`.

### Adaptations to the plan's interface

Each is forced by something in the code as it stands at 0.19.0.

1. **The pack is generic in its analyzer type.** `packs/pack.ts` declares
   only what analyzer _selection_ reads (`PackAnalyzer`: tool, provider,
   rung, scope); the orchestrator's `Analyzer` extends it with the runner.
   That keeps `pack.ts` a leaf that does not import the orchestrator, which
   imports the packs (the module graph has a no-circular rule, and type
   imports count), without moving `VerifyOptions` out of `verify/index.ts`.
2. **The TypeScript pack is built by a function that is handed its analyzer
   table**: `typescriptPack(analyzers)`. The plan has the pack own its
   analyzers. The runners (`runEslint` … `runStryker`) are about 2,000 lines
   of `verify/index.ts`; moving them would mark every line as changed, and the
   push gate mutates changed lines, so a no-behaviour move would cost a
   whole-file mutation run and risk a verdict difference for nothing. The
   table and its runners stay where they are; the orchestrator builds the pack
   from them (`stackPacks()`). A later change can move the runners in its own
   pull request.
3. **`isProviderDeclared` also takes the `package.json` names.** For
   TypeScript the answer is the repository's manifest, which `runVerify`
   already reads once (and tests inject); the Swift pack will read
   `stack.tools` instead and ignore the manifest.
4. **`ownerOf` and `coveringTests` are bound to a stack once per run and
   return a per-file function.** Both read from disk (workspace globs; up to
   800 test files and the TypeScript resolver), and today's code loads each
   once per run, lazily. A per-file method that took the context each time
   would reload on every call or hide a cache. `perStack` in
   `packs/stacks.ts` routes each file to the pack of the stack that owns it
   and binds a stack the first time one of its files is asked about.
   `coveringTests` wraps `covering-tests.ts` (now split into a per-file
   `coveringTestsFinder` under the unchanged `withCoveringTests`), and
   `ownerOf` wraps `workspaces.ts`.
5. **`lexer` and `signatures` are not pack members.** GR-04's own text puts
   both in `audit.ts`, keyed by file extension, and that is right: the
   auditor is deliberately one cross-language scan, and it reads a file that
   belongs to no stack, which a per-pack lookup could not.
6. **`detect` and `seeds` are deferred to the package that needs them**
   (GR-11, Swift `init` detection). An interface member with one
   implementation and no caller cannot be tested, only declared.
7. **The file predicates live in `packs/typescript-files.ts`**, apart from
   the pack object: `covering-tests.ts` asks `isTestFile` and the pack wraps
   `covering-tests.ts`, so one file would be a cycle.
8. **`silentlySkippedAnalyzers` stays TypeScript's question for `init`**
   (its signature and wording are unchanged); `runVerify` answers the same
   question per selected stack through the pack, so `--stack=swift` does not
   list TypeScript's undeclared tools.

### The TypeScript-specific surface (re-surveyed at `53b24da`)

| where                                                                                                                                                                          | what                                | this branch                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `verify/git.ts` `isTypeScriptFile`, `isTestFile`, `isConfigFile`                                                                                                               | file predicates                     | move to `packs/typescript.ts`                                                                         |
| `verify/index.ts` `ANALYZERS`                                                                                                                                                  | the analyzer table                  | handed to the pack; selection goes via packs                                                          |
| `verify/index.ts` `changedTypeScriptFiles`                                                                                                                                     | filters the diff to `.ts`           | returns all files; packs filter (GR-03)                                                               |
| `verify/index.ts` `missingToolViolation`                                                                                                                                       | `npm install --save-dev`            | `pack.installHint`                                                                                    |
| `verify/analyzer-policy.ts` `declaredProviders`                                                                                                                                | reads `package.json`                | behind `pack.isProviderDeclared`                                                                      |
| `autofix.ts`                                                                                                                                                                   | `eslint --fix`                      | `pack.autofix`                                                                                        |
| `workspaces.ts`                                                                                                                                                                | package attribution                 | `pack.ownerOf`                                                                                        |
| `covering-tests.ts`                                                                                                                                                            | related tests for a manifest        | `pack.coveringTests`                                                                                  |
| `audit.ts` `lexLine`, `SIGNATURES`, `AUDITABLE_EXTENSIONS`                                                                                                                     | JS lexer, signature table           | lexer table and `languages` (GR-04)                                                                   |
| `scope.ts` `DENIED_FILE_NAMES`                                                                                                                                                 | fixer denylist                      | gains the Swift tool configs (GR-04)                                                                  |
| `scaffold/detect.ts`, `seeds.ts`, `templates.ts`                                                                                                                               | `init` detection and seeds          | unchanged; pack members deferred to GR-11                                                             |
| `verify/prepare-cache.ts`, `importing-tests.ts`, `enclosing-spans.ts`, `import-graph.ts`, `typescript-loader.ts`, `verdict-dependencies.ts`, `mutate-ranges.ts` (planner half) | Stryker's cache and scope planner   | stay; they are internals of the TypeScript pack's `stryker` analyzer, reached only through its runner |
| `stryker-adapter.ts`, `mutation-lock.ts`, `mutate-ranges.ts` (range half)                                                                                                      | report schema, lock, changed ranges | already generic; reused by the Swift runner later                                                     |

### Config

```jsonc
{
  "stacks": [
    {
      "pack": "typescript",
      "root": ".",
      "exclude": ["ios/**"],
      "wholeProjectTrigger": "always",
    },
    {
      "pack": "swift",
      "root": "ios",
      "debugTargets": ["DialedDebugHooks"],
      "wholeProjectTrigger": "stack-changes",
    },
  ],
}
```

- **No `stacks` key means today's behaviour exactly**: an implicit
  `[{ "pack": "typescript", "root": ".", "exclude": [], "wholeProjectTrigger": "always" }]`.
  The same default applies when the key is not an array or yields no valid
  entry, so a broken block can never turn the TypeScript gates off.
- Parsing follows `config.ts`'s house style: key by key, anything of the wrong
  type keeps its default, and a dropped entry is named in
  `RepoConfig.stacks.warnings` (the shape `ship.warnings` uses), which
  `verify` and the gates print. An entry is dropped when it is not an object,
  when `pack` is not a known id, or when `root` is not a path inside the
  repository (blank, absolute, or climbing out with `..`).
- `root` is normalised to a repository-relative POSIX path with no leading
  `./` or trailing `/`; `"."` is the repository root.
- `wholeProjectTrigger` defaults per pack: `always` for TypeScript,
  `stack-changes` for Swift.
- Of the Swift-only keys, **only `debugTargets` is parsed in this branch**
  (the auditor reads it, GR-04). The others (`packages`, `app`,
  `developerDir`, `tools`, `allowlist`, `allowPluginsIn`, `importRules`,
  `mutate`, `mutateExclude`) are accepted and ignored. Each is parsed where
  its analyzer arrives, beside the code that gives it meaning: validation
  written before its consumer exists is a guess (what makes a tool pin or an
  allowlist entry well-formed is the adapter's to say).

## GR-03 — multi-stack scoping

1. The changed files are computed once per rung, as today (staged at commit,
   branch diff at push and ci), and **partitioned by stack**. A file belongs
   to the stack with the longest `root` that contains it and whose `exclude`
   globs do not match it. A file in no stack is ignored by stack analyzers;
   the auditor still lexes it by extension.
2. Within a stack, the files handed to analyzers are those the pack calls a
   source file or a config file. For TypeScript both predicates are subsets of
   today's `isTypeScriptFile`, so the list is identical to today's.
3. `selectAnalyzers` runs per stack, over that pack's table, in the order the
   stacks are configured. A web-only change runs no second-stack analyzer and
   the reverse.
4. `wholeProjectTrigger` decides when a stack's whole-project analyzers (knip,
   dependency-cruiser, npm-peers; later Periphery and the Swift graph checks)
   run below ci: `always` is today's behaviour; `stack-changes` runs them only
   when the stack owns a changed file of any kind. At ci they always run.
5. `verify` and `gate --mode=ci` take `--stack=<id>`: only stacks of that pack
   are selected, so a Linux job and a macOS job each run their own tools and
   neither reports the other's missing. The sanction-integrity check and the
   auditor run in both. An id that is not a known pack is a usage error
   (exit 2). An id no configured stack uses is an error-severity
   `guardrails/stack-unmatched` violation, not an empty pass: the macOS job
   of a repository whose Swift stack was deleted must not read clean for
   ever. The commit and push rungs refuse the flag (exit 2) rather than gate
   less than they were asked to.
6. A configured stack whose pack has no implementation in the running version
   (`swift`, until the adapters release) yields one `warn`-severity
   `guardrails/stack-unsupported` violation against `guardrails.config.json`,
   the same footing as `guardrails/analyzer-unknown`: the entry has no effect
   and the run says so. The owner may prefer `error`; see `QUESTIONS.md`.
7. Every violation an analyzer returns is stamped with `stack` (the pack id)
   **only when the config has a `stacks` key**, so the goldens, which have
   none, do not change. A TypeScript-only `stacks` block therefore reproduces
   the goldens in everything but that stamp, which is what its parity test
   asserts (and it counts the stamps, so a run that ignored the block cannot
   pass as one that honoured it).
8. `autofix` sends each edited file to the pack of the stack that owns it.

Analyzer names stay globally unique across packs, so one `analyzers` block
works and `analyzer-unknown` still catches typos.

Tests: fixture repositories with a dummy second pack injected through
`VerifyOptions.packs` (TypeScript only; TypeScript plus a second stack rooted
at `ios/`); a web-only diff selects no second-stack analyzer and the reverse;
a TypeScript-only `stacks` block at `always` reproduces the goldens; a config
with no Swift stack selects zero Swift analyzers at every rung.

## GR-04 — the Swift lexer and auditor rows

### The lexer

`guardrails-core/src/swift-lexer/`, imported by the auditor through a
per-extension lexer table in `audit.ts` and later by the mutation generator.
It differs from the JavaScript lexer in the ways Swift does:

- block comments nest and span lines; the lexer takes a line and a state and
  returns the next state, so a doc-comment line that mentions `try!` is a
  comment;
- `'` is not a string delimiter; backticks delimit identifiers, including raw
  identifiers with spaces;
- strings: `"…"` with `\( … )` interpolation whose contents are code,
  `"""` multi-line strings, raw strings `#"…"#` with `\#( … )` interpolation;
- regex literals: bare `/…/` by the JavaScript start heuristic, `#/…/#` by its
  own rule;
- every token records its kind, text, position, interpolation depth,
  adjacent whitespace and the previous significant token.

The existing JavaScript lexer is not touched: its `// Stryker disable all`
region is sanctioned by a `file|kind|text` key, and moving or rewording the
directive would stop the grant matching. The lexer table sits beside it in
`audit.ts`; the Swift lexer is a separate, fully mutated directory.

**Where a hunk starts.** A diff hunk can begin inside a multi-line comment or
string, and the diff alone cannot say so. The auditor takes an optional
`readSource`; when the post-change file is readable, the state at the hunk's
first line is computed by lexing the file from its first line (exact, and
cheaper to reason about than the plan's "enclosing declaration" search). When
it is not, the hunk's first line is treated as code: an over-match rather than
a miss. The limit is pinned by a test.

### Auditor rows

A `.swift` file is read by the Swift lexer against the Swift rows
(`audit-swift.ts`); a Swift tool's own config is read by the file rule
(`audit-tool-config.ts`); everything else is read as before. Which reader a
file gets is decided by the file alone, per hunk, in `audit.ts`
(`hunkAuditor`). `directive` rows are tested against the content of each
comment; `code` rows against the line's code, which includes the code of a
string interpolation and excludes string text, regex literals and backtick
identifiers; `setting` rows (the plan's "pkg") against the code and the text
of string literals, in `Package.swift` and `project.yml` only.

The rows are the plan's table: `swiftlint-disable`, `swiftformat-disable`,
`swift-format-ignore`, `periphery-ignore`, `mutation-suppress` (existing
kind), `ast-grep-ignore`, `unchecked-sendable`, `unsafe-isolation`,
`preconcurrency`, `assume-isolated`, `unsafe-expression`, `force-try`,
`force-cast`, `force-unwrap` (a token rule), `fatal-stub`, `skipped-test`
(existing kind), `test-time-limit`, `compile-escape`, `underscored-attribute`,
`unsafe-cast`, `retroactive`, `availability-hide`, `build-setting-escape`
and `tool-config-escape` (a file rule). `dupes-ignore` is left out until
a Swift duplication tool is approved.

Adaptations:

- **Dispatch by file instead of a `languages` field on one table.** The plan
  adds `languages: ['swift']` to rows of the single `SIGNATURES` table. A
  Swift line cannot be matched by that table's machinery at all: the table
  is applied to one line lexed alone, and Swift needs state carried across
  lines and a token rule. So the Swift rows are their own table, read by
  their own reader, and `audit.ts` picks the reader from the file. The
  guarantee the field was for holds by construction and is tested both ways:
  no Swift row is tested against a `.ts` or `.java` line, and no existing row
  against a `.swift` line. `.swift` is therefore not added to
  `AUDITABLE_EXTENSIONS` (that set selects the existing reader), and
  `isAuditableSourceFile`, which holds a sanctioned equivalent-mutant
  directive, is untouched.
- **Each pattern is written as small as it can be.** Where the plan's pattern
  has a fragment no input can tell from its absence (the optional
  `(?::next|:this|:previous)?` before a `\b`, `\w+` where `\w` decides the
  match), the fragment is left out: it matches the same lines and leaves no
  mutant that cannot be killed. Combined alternations are split into several
  rows of one kind where the repository's regex-complexity rule asks.
- **`.disabled(…)` and `.enabled(if:)` apply only under a test target** (a
  path segment ending in `Tests`). The plan's row is unscoped, and
  `.disabled(` is also SwiftUI's view modifier, on nearly every form: unscoped,
  it would block ordinary view code with no way past but a sanction per call.
  See `QUESTIONS.md`.
- **`force-unwrap` also takes `>` as the previous token**, so `Set<Int>!` (an
  implicitly unwrapped generic type) is caught; the lexer ends an operator at
  a `>` that `!` follows for this purpose.
- **`compile-escape` is two rows**: `#if DEBUG` (and `#if !DEBUG`), which a
  debug target is exempt from, and the rest (`#if false`, `canImport`,
  `…TEST…`), which nothing is.
- **`swiftlint:enable` and `swiftformat:enable` are not findings**: they turn
  checking back on. (`muter:enable` is, with `muter:disable`, as the plan's
  pattern has it.)
- **`swiftlint-disable` and `swiftformat-disable` are not anchored to the
  start of the comment.** The plan's patterns begin with `^`. Both tools'
  sources were read for this branch (SwiftLint `CommandVisitor.swift` and
  `Command.swift`, SwiftFormat `Formatter.swift`, on their default branches):
  each searches the comment for its marker (`comment.range(of: "swiftlint:")`,
  `comment.range(of: "swiftformat:")`) and takes the command from there, so
  `// TODO swiftlint:disable:next force_cast` is a live suppression that an
  anchored pattern would miss. These two rows therefore match the directive
  anywhere in a comment. The cost is that prose naming the full directive in
  a comment is flagged too, which is correct: the tool honours it as well.
  SwiftLint reads line comments only; the row still matches block comments
  (an over-match, the safe direction).
- **`periphery-ignore` stays anchored**: Periphery's `CommentCommand.swift`
  only respects a command at the start of a comment, in all four comment
  kinds. The lexer strips doc-comment markers from comment content, so
  `/// periphery:ignore` matches.
- **`ast-grep-ignore` ships as the plan wrote it, unverified**: its
  documentation host is not reachable from the build environment. See
  `QUESTIONS.md`.
- **`tool-config-escape` covers three files in this branch**: an added line
  under `disabled_rules` or `excluded` in `.swiftlint.yml`, an added
  `--disable` or `--exclude` in `.swiftformat`, and an added `retain_*` key in
  `.periphery.yml`. The import-rules file and the runner's `mutate`,
  `mutateExclude` and `operators` config are deferred to the packages that
  create them (GR-08, GR-15), because "any added line" in a file whose
  analyzer does not exist yet cannot be tested against a real consumer.
- **`compile-escape` and `debugTargets`.** `#if DEBUG` is exempt in a file
  under a target named in a Swift stack's `debugTargets`. Without a build
  graph, "under a target" is decided by path: a path segment equal to the
  target name (`…/Sources/DialedDebugHooks/…`, `…/DialedDebugHooks/…`).
- New `AuditKind` values join `sanctions.ts` validation automatically:
  `auditKinds()` is derived from the tables. `guardrails sanction` states
  what granting each new kind costs (`sanction-proposal.ts` holds a total
  record over the kinds, so a kind cannot be added without one).
- The gates give the auditor the post-change file and the stacks'
  `debugTargets`; `guardrails audit` and the sanction count re-derivation
  read whole files or bare diffs and need neither.
- `DENIED_FILE_NAMES` gains `.swiftlint.yml`, `.swiftformat`,
  `.periphery.yml` and `guardrails-imports.json`.

Tests are table-driven: every row has a positive case and non-matches in a
line comment, a nested block comment, a doc comment, a string, a multi-line
string, a raw string and a backtick identifier, plus a match inside an
interpolation. A separate test asserts no Swift row matches a `.ts` file and
no existing row matches a `.swift` file.

## GR-14 — the mutation generator

`guardrails-core/src/swift-mutate/` holds `generate.ts` and `operators.ts`
now, and the sandbox, runner, report and CLI later. Code under
`src/swift-mutate/` and `src/swift-lexer/` imports only Node built-ins and
each other; a dependency-cruiser rule, `swift-mutate-is-standalone`, fails any
other import, so the runner can be split into its own project if the owner's
watch items trip.

The generator lexes a file into tokens, and each operator proposes mutants
from tokens in code spans and in the code of string interpolations, never in
comments, string text, regex literals or backtick identifiers. A mutant is
kept only if its span intersects a requested line range. Each mutant records
`mutatorName`, `replacement` and a `location` (start and end, line and column,
in the mutation-testing-elements convention). A line
`// guardrails-mutate:disable-next-line <Operator> -- <reason>` directly above
a mutant marks it `Ignored`; the auditor blocks that directive unless it is
sanctioned.

The operators are the plan's seventeen: `EqualityOperator`,
`RelationalBoundary`, `RelationalNegation`, `LogicalOperator`,
`ConditionalExpression`, `BooleanLiteral`, `ArithmeticOperator`,
`UnaryOperator`, `AssignmentOperator`, `BlockStatement`, `StringLiteral`,
`IntegerLiteral`, `GuardNegation`, `NilCoalescing`, `OptionalChain`,
`IsEmptyNegation`, `MethodSwap`. Each is built on its own with tests for
placement, no placement in comments, strings and backtick identifiers,
placement inside interpolation, range intersection and the disable directive.

A lexer cannot see types. Where an operator needs to tell a binary operator
from a generic bracket or a prefix from an infix, it uses Swift's own rule,
whitespace: an operator with whitespace on both sides is infix. Formatted code
(SwiftFormat is the consumer's formatter) satisfies that; unformatted code
yields fewer mutants, never a misplaced one. Limits of this kind are listed in
the generator's tests.

## Proof that nothing changed for a TypeScript consumer

1. The goldens (GR-01) are recorded before any production change and never
   edited after.
2. In the seam commits, existing tests change only in import paths; the plan
   document lists every touched test file.
3. Swift is opt-in: a test asserts that a config with no Swift stack selects
   zero Swift analyzers at every rung and that no Swift row matches a `.ts`
   file; a second asserts that a TypeScript-only `stacks` block reproduces the
   goldens.
4. The consumer parity run before a tag (not this lane).

## Risks

- **Mutation cost at push.** Every changed line under `guardrails-core/src/`
  is mutated at the push rung. The seam is written to move as little code as
  possible for that reason.
- **Goldens and tool upgrades**, above.
- **A lexer is harder than it looks.** The owner's watch items for the runner
  apply to the lexer too: a false kill or a false survivor caused by the lexer
  counts toward the tripwire. The lexer's documented limits are in its tests.
