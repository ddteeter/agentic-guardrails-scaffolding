# Open questions — the Swift pack, first half

Branch `sprint/swift-pack`. Each entry: what is asked, what it costs, a
recommendation, and what the branch does meanwhile. The design is
`docs/superpowers/specs/2026-11-26-swift-pack-design.md`.

## 1. Release numbering for the pack

**What.** The plan numbered the pack's releases 0.15.0 to 0.19.0. Those are
taken; `main` is 0.19.0.

**Cost.** None to decide late. The documents name releases by content.

**Recommendation.** Minor releases, in order: the seam release (GR-01 to
GR-03) as 0.20.0, the Swift lexer release (GR-04) as 0.21.0, the adapters
release (GR-07 to GR-11) as 0.22.0, the runner release (GR-14 to GR-16) as
0.23.0. GR-14's generator ships dark in whichever release follows it, since
nothing calls it until the runner exists.

**Meanwhile.** No version is bumped, no tag cut; notes accumulate in
`guardrails-core/upgrades/unreleased.md`.

## 2. Should `StackPackId` reserve `'java'` now? — DECIDED

**Decision (the owner, 2026-11-27): no.** The id stays
`'typescript' | 'swift'`. Adding a member later is a one-line change, and a
reserved id would parse and then block every rung as an unsupported stack.
Java rows in the auditor apply exactly as before.

## 3. GR-01's baseline version

**What.** The goldens are recorded at the branch base (0.19.0, `53b24da`),
not at the plan's 0.14.2.

**Cost.** None; recording at 0.14.2 would compare today's code with behaviour
five releases old.

**Recommendation.** Confirm 0.19.0.

**Meanwhile.** Recorded at `53b24da`, before any change under `src/`.

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

## 16. The commit rung passed what the PreToolUse rung refused

**What.** Recorded in `plan.md` ("Roadmap: fixer-loop hardening"): the same
staged change was refused by `gate --mode=pretooluse` for duplication and
passed by the husky pre-commit gate minutes later. Not diagnosed in this
lane.

**Cost.** Unknown until diagnosed: either the commit rung under-reports
`dupes` for some staged sets, or the PreToolUse rung over-reports.

**Recommendation.** Reproduce at `345093f^` with that commit's change
staged, and compare the file lists the two rungs hand the dupes adapter.

**Meanwhile.** The branch does not depend on the answer: the tables were
restructured in `3b2f3fa`.

## 17. The generator's operator tables were strings — DECIDED, and changed

**Decision (the owner, 2026-11-27): write them as data.** The six infix swap
tables are now lists of `[from, to]` directions in
`src/swift-mutate/swap-tables.ts`. Each direction is its own array literal,
so Stryker empties them one at a time: 29 array mutants and 6 block mutants
in that file, all killed. (The operator strings themselves are still
`StringLiteral`s, which this repository's Stryker config excludes
everywhere.)
