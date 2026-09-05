# Mutation-gate integrity and stack upgrade — design

**Status:** accepted, unimplemented
**Tracking issue:** [#35](https://github.com/ddteeter/agentic-guardrails-scaffolding/issues/35)
**Supersedes nothing.** Extends the third-adoption findings in `plan.md`.

## 1. Why

A fourth greenfield adoption, run 2026-09-05 from the packed tarball, found
that **the mutation gate is broken on the stack a new consumer resolves today**
— and broken in the worst direction, manufacturing violations rather than
suppressing them.

The audit also found that this repository dogfoods a stack no new adopter gets:

|            | this repo | greenfield today     |
| ---------- | --------- | -------------------- |
| vitest     | 4.1.10    | **5.0.0**            |
| stryker    | 9.6.1     | **10.0.0**           |
| eslint     | 9.39      | **10.10**            |
| typescript | 5.9       | **6.0** (7.0 exists) |

The trust argument for this project is "we run it on ourselves." That argument
does not currently reach the versions a consumer installs. This spec closes the
gap in both directions: make the mutation gate tell the truth regardless of
version, and move this repo onto the current stack so dogfooding means
something again.

## 2. The upstream defect, measured

[stryker-mutator/stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210)
(open, filed 2026-09-04): Vitest 5 changed `testNamePattern` to join the
suite/test name chain with `' > '`; `@stryker-mutator/vitest-runner` still
builds its per-test filter with a space join, so the filter selects no tests.
Each mutant run executes nothing, and Stryker concludes "no test failed →
Survived."

Measured on a bare greenfield repo with one `tier(spend)` function and tests
asserting every boundary:

| stack                                        | result          |
| -------------------------------------------- | --------------- |
| stryker 10 + vitest-runner 10 + **vitest 4** | 12 Killed       |
| stryker 10 + vitest-runner 10 + **vitest 5** | **12 Survived** |
| stryker 9 + vitest-runner 9 + vitest 4       | 12 Killed       |

Stryker 10 is fine. Vitest 5 is the breaking variable. A probe test that
appended to a log on every execution ran **once** — the dry run — and never
again, under `coverageAnalysis: "off"` with 13 mutants.

**No configuration works around it.** All six combinations of
`coverageAnalysis` ∈ {`all`, `perTest`, `off`} × `vitest.related` ∈ {default,
`false`} report 12/12 Survived. There is no released
`@stryker-mutator/vitest-runner` that fixes it.

So `vitest` is pinned to `^4` here and in the guidance, and issue #35 tracks
unpinning it.

## 3. The invariant worth owning

We cannot fix the runner. We can stop it from lying, and the report carries an
exactly discriminating signal:

|                                           | `coveredBy` | `testsCompleted`    |
| ----------------------------------------- | ----------- | ------------------- |
| genuine survivor (vitest 4, vacuous test) | non-empty   | `1` — all 9 of them |
| broken runner (vitest 5)                  | non-empty   | `0` — all 12        |

**A mutant reported `Survived` with a non-empty `coveredBy` and
`testsCompleted === 0` is not evidence of survival. It is a run that never
happened.** A `Survived` verdict is only sound if at least one covering test
actually executed; zero executions means the runner returned an unexamined
default.

This is a general invariant, not a #6210 workaround. Upstream proposes the same
one for itself in
[#6146](https://github.com/stryker-mutator/stryker-js/issues/6146) ("never
report a mutant run that executed zero tests as survived"), unmerged since
July, and the same runner has three more open false-survivor bugs
([#6150](https://github.com/stryker-mutator/stryker-js/issues/6150),
[#6179](https://github.com/stryker-mutator/stryker-js/issues/6179),
[#6209](https://github.com/stryker-mutator/stryker-js/issues/6209)). The guard
stays after #6210 is fixed.

### 3.1 What it reports

One `guardrails/analyzer-failed` for the run, **not** one per affected mutant,
and **not** the bogus `stryker/survived` violations.

- **`analyzer-failed`, not a new rule id.** The existing rule means "the
  analyzer did not produce a trustworthy result", which is exactly the claim.
  It is already non-fixer-routable and already loose-classified; a new id would
  need a loose classification and fixer guidance for something no fixer can act
  on.
- **One violation, not twelve.** The finding is about the run, not about any
  mutant. Twelve copies of "your runner is broken" is the same context flood the
  terse-pointer design exists to prevent.
- **Fails closed.** Dropping the mutants and reporting nothing would be a
  fail-open on the one analyzer this pack most depends on.

### 3.2 Scope of the check

Only mutants whose file is in the changed set — the same `production` filter
`parseStrykerJson` already applies. A broken run in a file this change never
touched is not this change's problem, and widening the scope would make the
guard fire on unrelated history.

## 4. The drift guard

`instrumentedZeroMutants` is already protected by a live drift guard
(`test/drift/stryker-banner.test.ts`) that runs real stryker and asserts
guardrails still reads what it expects. **Nothing plays that role for the
question "does mutation testing still detect anything at all."** That is the
gap #6210 walked through.

A sibling guard runs real stryker over a fixture whose tests genuinely kill
their mutants, **through the vitest runner** — the one the adoption guidance
tells consumers to use — and asserts at least one `Killed` and zero `Survived`.

The banner guard deliberately uses the `command` runner to stay about the text.
This one deliberately uses `vitest`, because the runner integration _is_ the
thing under test. It is the only test in the suite that would have failed on a
`vitest@5` bump.

## 5. Toolchain upgrade

### 5.1 Moving

`eslint` 10.10, `@eslint/js` 10, `eslint-plugin-unicorn` 74 (needs eslint
≥10.4), `eslint-plugin-sonarjs` 4.2, `typescript-eslint` 8.69, `knip` 6.34,
`dependency-cruiser` 18.2, `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`
10.0.0, `typescript` ~6.0.

Per `CLAUDE.md`'s tool-upgrade rule, both hardcoded-id sites get the **judgment**
review, not just the mechanized existence check: `loose-rules.ts` (did these
majors add rules that should be loose-classified?) and `audit.ts` (did any
suppression syntax change?).

### 5.2 Pinned, with a reason in the file

`vitest` and `@vitest/coverage-istanbul` stay on `^4` until #6210 ships. The pin
carries a comment naming issue #35, because a pin whose reason is not written
down is a pin someone removes.

### 5.3 TypeScript 6 needs the dts build replaced

`typescript@~6.0` fails the build: `Error: error occurred in dts build` from
tsup 8.5.1, which is already the latest release. Plain `tsc` handles TS 6
fine — verified, exit 0 on this source tree.

So `tsup`'s `dts: true` is replaced by a `tsc --emitDeclarationOnly` pass:

- `dts: false` in `tsup.config.ts`.
- A new `guardrails-core/tsconfig.build.json` — extends the existing config,
  turns `noEmit` off, sets `emitDeclarationOnly`, `declaration`,
  `declarationMap`, `rootDir: src`, `outDir: dist`, and includes only `src`.
- `build` becomes `tsup && tsc -p tsconfig.build.json`, in that order: tsup's
  `clean: true` wipes `dist`, so declarations must be emitted after it.

This changes the shape of what ships — tsup bundled declarations into one
`dist/index.d.ts`; tsc emits one `.d.ts` per module, mirroring `src/`. That is
fine: `package.json`'s `files` already ships all of `dist`, and `exports`
already points `types` at `dist/index.d.ts`, which tsc still produces. A
package-exports test pins that the published entry points still resolve.

**TypeScript 7 is out of reach and not attempted.** `typescript-eslint` has no
v9 and 8.69 declares `typescript: ">=4.8.4 <6.1.0"`. The ceiling is theirs, as
the adoption guidance already explains.

## 6. Consumer-facing fixes

Four findings from the same audit, all in the scaffold rather than the machinery.

### 6.1 `reports/stryker-incremental.json` is not ignored

The seeded `.gitignore` block covers `reports/mutation/` and `.stryker-tmp/`.
Stryker's `incrementalFile` defaults to `reports/stryker-incremental.json`,
which is neither — so a greenfield repo's first `git add -A` **commits a
mutation-result cache**, and it churns on every run thereafter.

The fix is one more entry in `GITIGNORE_BLOCK`. Not a broader `reports/`: a
consumer's own reports directory is theirs, and guardrails ignores only what
guardrails generates.

**This is not a gate fail-open.** `runStryker` deletes the incremental file
before every run (`verify/index.ts`), so guardrails' own invocation is always
a fresh run. The exposure is a committed cache file and stale results for
anyone running `npx stryker run` by hand.

### 6.2 The seed-ordering trap

`seedOnceEntries` gates the three analyzer configs on `analyzerAsked` —
`required`, or `auto` with the provider already **declared**. On a bare
greenfield repo at `init` time none are declared, so `init --apply` writes no
`knip.json`, `stryker.conf.json`, or `.dependency-cruiser.cjs`. Install the
analyzers afterwards and the first `verify` reports
`analyzer-failed` for dependency-cruiser: _"Can't open a config file … You can
create one by running `npx dependency-cruiser --init`"_ — advice that, if
followed, writes a different config than the seed.

The README quickstart is `init --plan` → `init --apply` on a bare repo, so this
is the default path, not an edge case.

**The gating stays.** Its reason is sound: seeding a config for an analyzer
nobody asked for leaves an orphan `init` will never clean up. What is missing is
the pointer. `silentSkipWarning` already fires in exactly this situation —
enabled analyzer, undeclared provider — and already names the package to
install. It gains one clause: after installing, re-run `guardrails init --apply`
to seed the config. That warning already prints from `init` **and** from
`verify` and the commit/push/ci gates, so the pointer reaches the agent at the
moment it is stuck.

### 6.3 `git -c core.hooksPath=… commit` bypasses the Bash gate

`GIT_WRITE` is `/(?:^|[\n;&|()`{}])[ \t]*git\s+(?:commit|push)\b/`—`git`
must be immediately followed by the subcommand. Every git global option between
them is a miss.

`git -C <path> commit` is a documented, accepted miss: it still runs the repo's
hooks, so the git-native floor catches it. **`git -c core.hooksPath=/dev/null
commit` is not in that class** — it defeats the hooks, which is the whole point
of the floor, and it is the exact bypass the scaffolded `AGENTS.md` names
("never unsetting `core.hooksPath`"). The instruction forbids something the
hook does not detect.

The pattern learns git's global options: after `git`, allow zero or more
option tokens before the subcommand. It stays a command-position test, not a
shell parser — `FOO=1 git commit` and `xargs git commit` remain misses for the
reason already recorded, and the option class must stay disjoint from the
padding class so no input has two readings (this repo's own lint rejects the
super-linear alternative).

### 6.4 The guidance recommends the broken configuration

`adopting-guardrails` step 5 tells the adopter to swap `command` for a
framework runner, and its worked-example table pins a stack verified on
2026-09-04 — before #6210 was known. A greenfield repo following it today
resolves vitest 5 and gets a mutation gate that reports every covered mutant as
survived.

Step 5 gains the pin and the issue link. The table's `vitest` row is added with
its ceiling stated, in the same "the rule, not the numbers" framing the section
already uses for the TypeScript pin.

## 7. Out of scope

- **The knip/stryker `command`-runner catch-22.** On the current stack, the
  seeded `testRunner: "command"` makes knip report
  `@stryker-mutator/command-runner` as an unlisted dependency, and that package
  **does not exist** (404 — it is bundled into core in v10), so the finding is
  unsatisfiable. With §6.4 pinning vitest 4, the guidance's runner swap clears
  it, which is the documented resolution. Revisit if the seed's default runner
  changes.
- **TypeScript 7**, per §5.3.
- **An oxlint adapter**, unchanged from the first adoption's roadmap.
