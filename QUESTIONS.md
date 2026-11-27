# Questions — the Swift pack, first half

Branch `sprint/swift-pack`. Each entry: what was asked, what it costs, a
recommendation, and what the branch does. The design is
`docs/superpowers/specs/2026-11-26-swift-pack-design.md`.

Entries marked DECIDED were answered by the owner on 2026-11-27 and the
branch reflects the answer. **Still open:** 5 (ast-grep's syntax, to verify
with the tool at GR-07), 6 and 14 (owner-only items for the later lanes).

## 1. Release numbering for the pack — DECIDED

**Decision (the owner, 2026-11-27): names only for now.** The plan's 0.15.0
to 0.19.0 are taken. The documents keep naming releases by content (the seam
release, the Swift lexer release, the adapters release, the runner release),
and the owner assigns numbers when cutting each, which also settles whether
this branch ships as one release or several. No version is bumped and no tag
cut on this branch.

## 2. Should `StackPackId` reserve `'java'` now? — DECIDED

**Decision (the owner, 2026-11-27): no.** The id stays
`'typescript' | 'swift'`. Adding a member later is a one-line change, and a
reserved id would parse and then block every rung as an unsupported stack.
Java rows in the auditor apply exactly as before.

## 3. GR-01's baseline version — DECIDED, and compared with 0.14.2

**Decision (the owner, 2026-11-27): the 0.19.0 goldens stand, and 0.14.2 is
compared once, as information.**

**Result: no difference.** The 0.14.2 tree (tag `v0.14.2`, `65a4570`) was
built in a scratch directory and its CLI run against all 20 fixtures, four
commands each, installed inside each fixture as a consumer would have it.
All 80 results (exit code, stdout, stderr and violations manifest) are
identical to the goldens recorded at 0.19.0.

**What that does and does not show.** It shows that, for these fixtures, a
consumer's verdicts did not change between 0.14.2 and 0.19.0, so the plan's
baseline and this branch's are the same in effect. It was run with today's
analyzer versions (this repository's current lockfile), not 0.14.2's, and
`guardrails-core` is not on the npm registry, so the old version was built
from its tag with today's build tools rather than installed as published.
The comparison is a one-off script and is not part of the suite.

## 4. A real Stryker run in the goldens, and what the suite costs — DECIDED

**Decision (the owner, 2026-11-27): the parity suite stays in `npm test`.**

For the record, measured on the cloud machine (four cores): the parity file
takes about 67 s of wall-clock time on its own. That is two passes over the
20 fixtures (the goldens, and the same fixtures with an explicit
TypeScript-only `stacks` block), four commands each, the real Stryker run
included, two fixtures at a time. The full suite's wall-clock time on that
machine went from about 80 s on `main` to about 130 s.

## 5. ast-grep's Swift support and suppression syntax

**What.** The plan marks ast-grep's Swift support unverified. It is still
unverified: its documentation host could not be reached from the build
environment. GR-04 ships the `ast-grep-ignore` row as the plan wrote it
(a comment that starts with `ast-grep-ignore`).

**Cost.** If the real syntax differs, the row under-matches until GR-07
corrects it. Nothing uses ast-grep before GR-07.

**Recommendation.** Verify at GR-07 with the tool installed: a fixture with a
known finding, suppressed, run through the real binary (the live-guard shape
`CLAUDE.md` asks for).

**Meanwhile.** The row ships as written and is marked unverified in its test.

## 6. Owner-only items from the plan, untouched here

- jscpd, PMD CPD, or no Swift duplication gate (the `dupes-ignore` row is left
  out until this is decided).
- swift-openapi-generator's supporting packages on the allowlist.
- The exact pins of the approved third-party packages.
- macOS runner usage in CI.
- The tripwire ceilings, shown again with real timings before the runner's
  release.

## 7. The suite assumed a non-root user and no global `NODE_PATH` — DECIDED, and fixed

**Decision (the owner, 2026-11-27): fix the tests on this branch.**

On a clean `main`, run as root with a global `NODE_PATH` that holds
`typescript` (a cloud agent's container; many CI images run as root), 11
tests failed. (An earlier version of this entry split them 8 and 3; the
split is 7 and 4.)

- **Seven expected a write or a read to be refused** after `chmod`, which
  root ignores. Each now sets up a failure that holds for every user: a
  directory where the run log should be (five tests in
  `gate-run-log.test.ts`, `run-log.test.ts` and `ship.test.ts`; two of them
  asserted `EACCES` by name and now assert `EISDIR`), and in
  `repo-source.test.ts` a symbolic link to itself and a path through a file
  in place of the two `chmod 000` cases.
- **Four expected no `typescript` to be resolvable** from an empty temporary
  repository (`typescript-loader.test.ts`, two in `import-graph.test.ts`, one
  in `gate.test.ts`). `test/without-global-modules.ts` takes `NODE_PATH` out
  of module resolution for those files and restores it afterwards.

No test was removed and none is skipped: the suite is 128 files and 6,061
tests either way, and passes both as root with `NODE_PATH` set and as an
ordinary user.

**What the fix does not cover.** The production loader still resolves a
`typescript` that is only reachable through `NODE_PATH`, for a consumer that
installed none. Whether the gate should refuse a globally installed
TypeScript is a behaviour question for TypeScript consumers and was left
alone.

## 8. Goldens contain tool output — DECIDED

**Decision (the owner, 2026-11-27): a narrow exception.** A golden may change
in a commit that changes `package-lock.json` and nothing under
`guardrails-core/src/` (a tool upgrade that rewords an analyzer's own
message). Every other golden change still needs its own owner-approved pull
request naming the behaviour change. `guardrails-core/docs/releasing.md`
states this as the rule.

## 9. A configured stack whose pack is not implemented yet — DECIDED

**Decision (the owner, 2026-11-27): error.** Until the adapters release,
`"pack": "swift"` yields one error-severity `guardrails/stack-unsupported`
violation and blocks at every rung. The branch first shipped it as a warning.

**What follows from it.** A Swift stack cannot be configured early, so the
auditor's `debugTargets` exemption is not reachable until `packs/swift.ts`
exists; `#if DEBUG` in a debug target needs a sanction meanwhile. Once every
known id has a pack, the path can be deleted.

## 10. `tool-config-escape`: the import-rules file and the runner's config — DECIDED

**Decision (the owner, 2026-11-27): defer.** The rule for
`guardrails-imports.json` is built with GR-08 and the rule for the runner's
`mutate`, `mutateExclude` and `operators` config with GR-15, each where it
can be tested against the real format, and where it can be decided whether a
line that tightens a rule is exempt. Meanwhile `tool-config-escape` covers
`.swiftlint.yml`, `.swiftformat` and `.periphery.yml`, and
`guardrails-imports.json` is on the fixer denylist.

## 11. `swiftlint:disable` and `swiftformat:disable` anywhere in a comment — DECIDED

**Decision (the owner, 2026-11-27): keep the un-anchored match.** Both tools'
sources search the comment for their marker, so a directive after other
words in a comment is a live suppression and is flagged.
`periphery:ignore` stays anchored, as its parser is.

## 12. `.disabled(…)` and `.enabled(if:)` are audited under test targets only — DECIDED

**Decision (the owner, 2026-11-27): keep the scope.** The two trait rows
apply only to a file with a path segment ending in `Tests`; SwiftUI's
`.disabled(…)` in app code is never flagged. When the adapters lane has
`swift package dump-package`, replace the path rule with the real test
targets.

## 13. Where the Swift rows live — DECIDED

**Decision (the owner, 2026-11-27): keep the split.** The Swift rows stay in
`audit-swift.ts` with their own reader, and `audit.ts` picks a reader per
file. The costs were named and accepted: two places to read what the auditor
flags, and two matchers that a later fix has to be applied to separately.

## 14. What the later lanes need from the owner (this lane stopped at the Linux boundary)

- **A macOS machine with Xcode** for GR-07 onward: the adapters are written
  against real tool output, and the plan asks for the tools' outputs to be
  re-recorded as fixtures first (SwiftLint, SwiftFormat, `swift build`
  diagnostics, Periphery, `dump-package`).
- **The tool pins** for `swiftformat` and `ast-grep` (the plan has
  `<pinned>`), and confirmation of SwiftLint 0.65.1, Periphery 3.8.0,
  XcodeGen 2.46.0 and xcbeautify 3.2.1.
- **A macOS CI runner decision** (usage and cost), since `--stack=swift`
  exists so that job can run only its own tools.
- **The consumer's Swift package layout**, to replace the two path rules in
  the auditor (test targets, debug targets) with `dump-package` facts.
- **The parity run on the consumer** before the seam release is tagged
  (`guardrails-core/docs/releasing.md`).

## 15. A rule table reads as duplicated code — DECIDED, and no ignore was needed

**Decision (the owner, 2026-11-27):** an ignore was offered for the mutant
generator's tables so they could be written as data (entry 17). It turned
out not to be needed: as data, one small function per table in
`src/swift-mutate/swap-tables.ts`, they report no clone, so
`.fallowrc.jsonc` is unchanged and nothing is exempt from the check.

**Still true.** The auditor's Swift rows (`audit-swift.ts`) are one row per
kind for the same reason, and report no clone. A long run of same-shaped rows
added later could bring a finding back; if it does, the choice is the
owner's again.

## 16. The commit rung passed what the PreToolUse rung refused — DECIDED, diagnosed and fixed

**Cause.** The commit rung takes its file list from the index and every
analyzer reads the file from disk. The staged file had been edited on disk
while the gate ran, so the gate judged content the commit did not hold. The
PreToolUse rung had run earlier, on the unedited file, and was right.

**Decision (the owner, 2026-11-27): block when they differ.** At the commit
rung a staged file whose working copy differs from the index is an
error-severity `guardrails/staged-differs` violation naming the file,
checked before the analyzers (which are then not spawned) and again after
them. No golden changed. This is the one change on the branch that alters a
verdict for a TypeScript consumer: a partially staged file (`git add -p`)
is refused until the rest is staged or stashed. It is in the upgrade notes.

## 17. The generator's operator tables were strings — DECIDED, and changed

**Decision (the owner, 2026-11-27): write them as data.** The six infix swap
tables are now lists of `[from, to]` directions in
`src/swift-mutate/swap-tables.ts`. Each direction is its own array literal,
so Stryker empties them one at a time: 29 array mutants and 6 block mutants
in that file, all killed. (The operator strings themselves are still
`StringLiteral`s, which this repository's Stryker config excludes
everywhere.)
