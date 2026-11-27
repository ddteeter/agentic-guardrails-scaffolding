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

## 2. Should `StackPackId` reserve `'java'` now?

**What.** `plan.md` lists a Java pack as Phase D, and `audit.ts` already has
Java rows. The plan's `StackPack.id` is `'typescript' | 'swift'`.

**Cost.** Adding a member later is a one-line, non-breaking change. Adding it
now means `stacks` parsing accepts `"pack": "java"` for a pack that does not
exist, which then needs the "unsupported pack" path (question 9) forever.

**Recommendation.** Do not reserve it. The seam does not close the door: the
id is a union, the registry is a list, and the auditor's `languages` field
already distinguishes rows by language.

**Meanwhile.** `'typescript' | 'swift'`. Java rows apply exactly as before.

## 3. GR-01's baseline version

**What.** The goldens are recorded at the branch base (0.19.0, `53b24da`),
not at the plan's 0.14.2.

**Cost.** None; recording at 0.14.2 would compare today's code with behaviour
five releases old.

**Recommendation.** Confirm 0.19.0.

**Meanwhile.** Recorded at `53b24da`, before any change under `src/`.

## 4. A real Stryker run in the goldens, and what the suite costs

**What.** The parity suite runs the real analyzers. Stryker runs in one
fixture, four times (commit, push, ci, `verify`).

**Cost.** Measured on the cloud machine (four cores): the parity file takes
about 67 s of wall-clock time on its own. That is two passes over the 20
fixtures (the goldens, and the same fixtures with an explicit TypeScript-only
`stacks` block), four commands each, the real Stryker run included, two
fixtures at a time. At five at a time it was faster but starved a
timing-sensitive drift guard elsewhere in the suite. It runs in `npm test`,
`test:coverage` (so at every push) and CI; the full suite's wall-clock time
on that machine went from about 80 s on `main` to about 130 s.

**Recommendation.** Keep the real run; it is the only golden that would have
caught a change to how Stryker is invoked or read. If the time is unwelcome
at push, move the parity suite behind its own script that CI and
`guardrails ship` run, and leave `npm test` without it.

**Meanwhile.** It runs in `npm test`.

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

## 7. The suite assumes a non-root user and no global `NODE_PATH`

**What.** On the cloud machine this lane ran on, `npm test` on a clean `main`
failed 11 tests. Eight are permission tests (`chmod 000`, then expect a read
or write to fail); root ignores file modes, so they cannot fail closed. Three
expect "no `typescript` installed" in a temporary repository; a global
`NODE_PATH` made one resolvable. With the DAC-override capability dropped and
`NODE_PATH` unset, all 4,264 tests pass on `main`.

**Cost.** Any container that runs as root (many CI images, every cloud agent
session) sees a red suite on a green tree.

**Recommendation.** Have the eight tests skip when the process can read a
mode-000 file it just wrote (a capability probe, not a user-name check), and
have the three clear `NODE_PATH` for the loader they exercise. Both are test
changes, outside this lane's scope.

**Meanwhile.** Nothing in the branch changes these tests. The lane ran every
command through a wrapper that drops the capability and unsets `NODE_PATH`.

## 8. Goldens contain tool output

**What.** A golden is the real analyzers' output. An ESLint, TypeScript, knip,
dependency-cruiser, Stryker or fallow upgrade that rewords a message changes a
golden with no guardrails behaviour change, which collides with "no later
change may edit a golden".

**Cost.** Either dependency bumps need the owner-approved golden pull request
too, or the rule gets a second, narrower exception.

**Recommendation.** Allow a golden edit in a commit that changes
`package-lock.json` and nothing under `guardrails-core/src/`, and say so in
`docs/releasing.md`. Masking tool text instead would hide exactly the adapter
changes the goldens exist to catch.

**Meanwhile.** Goldens hold tool text verbatim, at the lockfile's versions.

## 9. A configured stack whose pack is not implemented yet

**What.** Until the adapters release, `"pack": "swift"` parses but has no
analyzers. The branch reports one `warn`-severity
`guardrails/stack-unsupported` violation per such stack and does not block.

**Cost.** `warn` means a consumer who configures a Swift stack early (to get
the `debugTargets` exemption for the auditor rows, which do work) is not
blocked, and also means a Swift stack silently runs no analyzer apart from
that warning. `error` is the house rule for a guard that could not run, and
would make the early configuration impossible.

**Recommendation.** Keep `warn` until the adapters release, then delete the
path: once `packs/swift.ts` exists every known id has a pack.

**Meanwhile.** `warn`.

## 10. `tool-config-escape`: the import-rules file and the runner's config

**What.** The plan flags "any added line" in the import-rules file and in the
runner's `mutate`, `mutateExclude` and `operators` config. Neither the
`swift-imports` analyzer (GR-08) nor the runner's config block (GR-15) exists
yet, and "any added line" also flags a line that tightens a rule.

**Cost.** Deferring means those two files are protected only by the fixer
denylist until their packages land (the denylist is what stops a fixer; the
auditor row is what stops the main agent).

**Recommendation.** Build each with its package, and decide then whether an
added `forbidden` rule (a tightening) should be exempt.

**Meanwhile.** `tool-config-escape` covers `.swiftlint.yml`, `.swiftformat`
and `.periphery.yml`. `guardrails-imports.json` is on the fixer denylist.

## 11. `swiftlint:disable` and `swiftformat:disable` anywhere in a comment

**What.** The plan anchors both patterns to the start of the comment. Both
tools' sources search the comment for their marker, so
`// TODO swiftlint:disable:next force_cast` is a live suppression. The branch
matches the directive anywhere in a comment for these two rows.

**Cost.** A comment that merely names the full directive is flagged; the tool
would honour that comment too, so the finding is true.

**Recommendation.** Keep the un-anchored match.

**Meanwhile.** Un-anchored for these two; `periphery:ignore` stays anchored,
as its parser is.

## 12. `.disabled(…)` and `.enabled(if:)` are audited under test targets only

**What.** The plan's `skipped-test` row for Swift Testing traits is
`\.disabled\s*\(` on any Swift line. `.disabled(` is also SwiftUI's view
modifier (`Button(…).disabled(!isValid)`). The branch applies the two trait
rows only to a file with a path segment ending in `Tests`.

**Cost.** A Swift Testing trait written outside such a path (a test helper in
a support target, say) is not flagged. Unscoped, every form in the app would
need a sanction.

**Recommendation.** Keep the scope. When the adapters lane has
`swift package dump-package`, replace the path rule with the real test
targets.

**Meanwhile.** Scoped by path.

## 13. Where the Swift rows live

**What.** The plan adds the Swift rows to `SIGNATURES` in `audit.ts` with a
`languages` field. The branch keeps them in `audit-swift.ts`, read by the
Swift lexer, and `audit.ts` picks a reader per file. `auditKinds()` still
knows every kind.

**Cost.** Two tables instead of one. The existing table's matcher takes one
line lexed alone and cannot run a Swift row at all, so one table would have
needed two matchers behind one list.

**Recommendation.** Keep the split; it is the same single auditor.

**Meanwhile.** Split, with tests that no Swift row matches a `.ts` or `.java`
line and no existing row a `.swift` line.

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

## 15. A rule table reads as duplicated code

**What.** `fallow dupes` in semantic mode ignores identifier names and
literal values, so a table of rows with one shape (the auditor's Swift rows,
as first written) is reported as clones of itself and of the existing
signature table. The repository's `.fallowrc.jsonc` already carries one
`duplicates.ignore` entry for exactly this class (`state-store.ts`, "shapes
rhyme"). This lane did not add one: an ignore is a weakened check, and that
is the owner's to grant.

**Cost.** The rows are modelled as one row per kind holding its patterns,
which is a fair model and reports no clone. But the absence of a finding
depends on no two long runs of rows having the same shape, so adding a few
single-pattern rows in a block could bring it back.

**Recommendation.** If it comes back, grant `guardrails-core/src/audit-swift.ts`
a `duplicates.ignore` entry with the reason recorded, as was done for
`state-store.ts`; and consider having the dupes adapter drop a clone group
whose every instance lies inside one array or object literal (a behaviour
change for TypeScript consumers, so not this lane's).

**Meanwhile.** No ignore; no finding.

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

## 17. The generator's operator tables are strings, which Stryker does not mutate

**What.** In `src/swift-mutate/` the infix swap tables are written as strings
(`'== != === !=='`) and split at run time. This repository's Stryker config
excludes `StringLiteral` mutants, so the tables themselves are not mutated.
The delegated agent chose this to avoid clone groups between six tables of
pairs (question 15's problem again). Every pair is asserted by a test in
both directions.

**Cost.** The 100% score on `src/swift-mutate/**` is over the code, not over
the table contents. A wrong entry in a table would be caught by its test,
not by a mutant.

**Recommendation.** Accept it, or decide question 15 (a `duplicates.ignore`
for rule tables) and have the tables written as data again.

**Meanwhile.** Strings, with a test per pair.
