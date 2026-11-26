# Adopting guardrails

This is the document a real adopter reads: what `guardrails init` writes, what
each analyzer costs, and what to do before turning on enforcement. Every claim
below is checked against `guardrails-core/src/scaffold/` and
`guardrails-core/src/verify/index.ts` as of this writing — if behavior drifts,
this doc is wrong until it is updated to match, not the other way around.

## Install

`guardrails-core` ships as a GitHub Release tarball, not from npm:

```bash
npm i -D https://github.com/ddteeter/agentic-guardrails-scaffolding/releases/download/v0.18.2/guardrails-core-0.18.2.tgz
```

That URL resolves once `v0.18.2`'s release workflow has run — a release is a
pushed `v*` tag, which packs the tarball and attaches it. A later version is a
new tag, a new release asset, and a hand-edited URL — see the cost note below.

**What a URL dependency costs you:** no semver range (you get exactly the
tarball at that URL, forever, until you edit the line), no dedupe (npm cannot
collapse it against another copy the way it would a registry package), and no
Dependabot tracking (Dependabot only watches registry ranges — an upgrade here
is a manual URL edit, checked in like any other dependency bump). This is
deliberate while the package has no npm-registry presence; publishing to npm
later changes this one line and nothing else.

Installing the tarball does not wire anything up. `guardrails init` does that.

## `init --plan`, then `init --apply`

```bash
node ./node_modules/guardrails-core/dist/cli.mjs init --plan   # print what would be written; touches nothing
node ./node_modules/guardrails-core/dist/cli.mjs init --apply  # write it
```

Invoked by path rather than `npx guardrails-core`. npx resolves a bin NAME and
falls through to the registry when nothing local provides it, so the bin is
named after the package: a miss can only ever fetch this package, never someone
else's. (It was `guardrails` until the rename — a real, unrelated package sits
under that name.) A miss can still fetch a different VERSION than you installed,
which is why the path form is the one documented here and the one CI uses.

There is no interactive mode and no TTY probe: a non-TTY invocation of `init`
(no `--apply`) behaves identically to `--plan`. `--apply` is the only way past
the read-only default, and `--plan`/`--apply` are mutually exclusive on one
invocation.

`init` is re-runnable — on every run it recomputes the same plan from what is
already on disk and (for OWNED files) the checksums recorded in
`.guardrails/scaffold.json`, so running it twice against an unmodified repo is
a no-op except for the SHARED files, which always report `merge` (see below).

Flags: `--json` (machine-readable plan/result), `--force` (overwrite OWNED
files you have edited — never SEED-ONCE), `--analyzers=<tool>=<off|auto|required>[,...]`,
`--enforcement=warn|block`, `--distribution=solo|team`.

All three decision flags only affect the run that **seeds**
`guardrails.config.json`. Once that file exists it is SEED-ONCE, so a later
`init` cannot change your policy — and, since it is then the authority,
guardrails reads the analyzer policy out of that file rather than out of the
flags when deciding what else to write. `--distribution` records a value no
code path reads; it is a field a team declares for humans.

## Who owns each written file

`init` writes three kinds of files, and the difference matters the moment you
edit one of them by hand.

| Class         | Behavior                                                                                                                                                                                                                                                                                                                                               | Examples                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OWNED**     | Absent → created. Unmodified since scaffolding (checksum in `.guardrails/scaffold.json` still matches), or only reformatted by your formatter (same words, see below) → silently rewritten on the next `init --apply`, so upgrades land automatically. Edited by you → left alone and reported as `drift` in the plan; `--force` overwrites it anyway. | `.claude/agents/guardrail-fixer*.md`, `.codex/agents/guardrail-fixer*.toml`, `.github/agents/guardrail-fixer*.agent.md`, `.github/hooks/guardrails.json`, `.githooks/pre-commit`, `.github/workflows/guardrails.yml`, `docs/guardrails/*.md`, `.claude/skills/*/SKILL.md` |
| **SHARED**    | Absent → the whole file is created. Present → always `merge`: guardrails splices in only its own entries (a hooks block, a gitignore stanza, the `prepare` script line, a marked doc section) and leaves everything else in your file untouched. Never reports `drift`, never sensitive to `--force`.                                                  | `.claude/settings.json`, `.codex/hooks.json`, `AGENTS.md`, `.gitignore`, `package.json`, `.github/copilot-instructions.md`                                                                                                                                                |
| **SEED-ONCE** | Absent → created once. Present → left alone, forever — `--force` included.                                                                                                                                                                                                                                                                             | `guardrails.config.json`, `.dependency-cruiser.cjs` (only if dependency-cruiser is enabled and no config exists yet), `stryker.conf.json` (same, for stryker), `knip.json` (same, for knip), `.fallowrc.jsonc` (same, for dupes)                                          |

`guardrails.config.json` is the one file `--force` can never touch: it holds
your policy and your `sanctionedSuppressions`, and losing it is the worst
thing this command could do.

**One exception to "guardrails only writes its own entries": a `.gitignore` it
creates from scratch also gets `node_modules/`, above the marker block.** On a
repo that already has the file, guardrails adds nothing outside its block —
your file already ignores your dependencies. On a greenfield repo there is no
such file, so the block would be the whole thing and `node_modules/` would be
untracked-but-not-ignored; `git ls-files --others` then reports every installed
file as a change, and eslint dies walking up into a dependency's own flat
config. The line is written outside the markers because it is yours from the
moment it lands: a later `init` leaves it alone, and deleting it is your call.
Deleting it does not break the gate — `verify` filters dependency paths out of
the changed set independently — it only makes `git status` unusable.

`.githooks/pre-commit` is written but inert on its own — git only runs hooks
from `.git/hooks` unless told otherwise. `init --apply`'s `package.json`
merger appends `guardrails-core install-hooks` to the `prepare` script, and
that command is what points `core.hooksPath` at `.githooks` (resolved against the
real repo root, not the current directory, so it still targets the right repo
from inside a monorepo package). `npm install` runs `prepare` automatically,
which is what gets a fresh clone or a teammate's checkout onto the commit gate
without anyone running a command by hand.

**Unless you already have a `core.hooksPath`.** git accepts exactly one hooks
directory, so pointing it at `.githooks` would silently disable every hook you
already have there — and husky sets it to `.husky/_`. Neither `init --apply`
nor `install-hooks` will do that. If `core.hooksPath` is set to anything other
than `.githooks`, both leave it exactly as they found it, write
`.githooks/pre-commit` anyway, and warn — in the `--plan` output as well as the
`--apply` output — naming the value they found. Your gate is then **not**
installed: add

```sh
node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=commit
```

to the pre-commit hook you already have, and this to your pre-push hook:

```sh
node ./node_modules/guardrails-core/dist/cli.mjs gate --mode=push
```

Then the checks run inside your existing hooks instead of replacing them. Both
matter: `--mode=commit` scopes to the staged files so committing stays fast,
and `--mode=push` is what re-checks the whole branch before it leaves the
machine.

One SHARED file is a special case worth calling out: **`.claude/settings.json`
is re-serialized on every merge**, even when nothing guardrails-owned changed.
If your formatter disagrees with the merger's (2-space, alphabetical-ish key
order), you'll see it reformatted on every `init --apply` and reformatted back
by your own tooling afterward. Harmless, but don't be surprised by the diff.

## What each analyzer costs at which rung

Not every analyzer runs on every turn. `guardrails-core/src/verify/index.ts`'s
`ANALYZERS` table gates each one by a minimum cadence rung:

| Analyzer           | Runs at                                   | Scope                                                                                  |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| eslint             | every turn (Stop gate), commit, push, CI  | diff-scoped — only changed TypeScript files are linted                                 |
| tsc                | every turn (Stop gate), commit, push, CI  | triggered by a changed file, but checks the whole project (type errors are cross-file) |
| knip               | commit, push and CI only                  | whole-project                                                                          |
| npm-peers          | commit, push and CI only                  | whole-project — asks `npm ls` which installed versions violate a peer range            |
| dependency-cruiser | commit, push and CI only                  | whole-project                                                                          |
| stryker            | commit, push and CI only                  | diff-scoped to changed production files                                                |
| dupes              | commit, push and CI only (opt-in)         | whole-tree discovery, diff-scoped reporting: clone groups touching a changed file      |
| complexity         | commit, push and CI only (on with fallow) | whole-tree run, diff-scoped reporting: over-threshold functions in a changed file      |

`dupes` and `complexity` are the two analyzers whose default is not plain
installed-means-enabled. `dupes` is **`off` by default**, and `complexity` is
**on by default where `fallow` is declared** in your `package.json`, `off`
otherwise. `dupes` runs `fallow dupes`, which finds copy-paste across
files — the gap `eslint-plugin-sonarjs` looks like it covers and structurally
cannot, because ESLint receives one file's AST at a time and holds no cross-file
state. Its precision depends on an ignore list only you can write (generated
files, ORM schema DSLs, framework boilerplate), so an unconfigured run reports
rhyming code rather than duplication worth fixing. Turn it on with
`"dupes": "required"` in the `analyzers` block, then tune the `.fallowrc.jsonc`
that `init` seeds once and never rewrites.

It needs the whole tree to find a clone PAIR, but reports only groups with at
least one side in your diff — so a pre-existing clone does not re-report on
every commit; it surfaces the first time you touch a file involved in it. When
it does report, it names **every** site in the group, including sides your diff
never touched, because a fixer shown half a clone pair cannot deduplicate it.

`complexity` runs `fallow health --complexity` and reports functions over
fallow's cyclomatic and cognitive thresholds (20 and 15 unless you change them)
in the commit that pushes them over, rather than at a pre-push
`fallow --fail-on-issues` an hour later. ESLint's
`sonarjs/cognitive-complexity` at the same limit does not close that gap: it
counts differently, and a function it passes can still fail fallow. If your
`package.json` declares `fallow`, it is on with no configuration: having fallow
installed means your fallow config already says what "too complex" means. Where
fallow is not declared it stays `off`, so it never shows up in the "enabled but
not installed" warning. Opt out with `"complexity": "off"`, or set
`"complexity": "required"` to make a missing fallow block. **Upgrading:** a repo
that declares fallow and has no `complexity` key starts running it at commit,
push and CI on upgrade. The invocation passes no thresholds and no
paths, so fallow reads `health.maxCyclomatic`, `health.maxCognitive` and
`health.ignore` from your own fallow config, and the commit rung and your
pre-push gate agree by construction.

It reports cyclomatic and cognitive complexity only. **CRAP is excluded**:
fallow folds coverage into a CRAP score, and at the commit rung coverage is
stale or absent (fallow estimates it), so a CRAP finding there says little.
Keep CRAP at pre-push and CI, where coverage is fresh. Findings route to the
thorough fixer, which is told to extract helpers rather than add the
`fallow-ignore-next-line complexity` comment fallow itself suggests; the
diff-auditor flags that comment if a fixer adds it anyway.

The practical read: eslint and tsc are cheap enough to run after every agent
turn. knip, dependency-cruiser, stryker, dupes and complexity are whole-graph or mutation
analysis — too slow for a per-turn gate — so they only fire at `git commit`
(via `.githooks/pre-commit`), at `git push` (via `.githooks/pre-push`), and in
CI.

**Three local rungs, differing only in which change set the diff-scoped
analyzers see.** `--mode=commit` scopes them to the **staged** files, so the
cost of committing does not grow with the length of the branch — under a
branch-wide scope, stryker re-mutates every production file the branch has
touched on every single commit. `--mode=push` and `--mode=ci` scope to the
branch diff instead. Every file is still mutation-gated in the commit that
changes it; what the wider scope adds is the interaction a per-commit scope
cannot see — a commit that removes the test killing a mutant in a file it does
not itself touch — and `.githooks/pre-push` catches that before the code leaves
the machine. The diff-auditor and sanction budget always audit the branch diff,
in every mode, so a suppression added in an earlier commit keeps flagging.

An analyzer set to `"off"` in
`guardrails.config.json`'s `analyzers` block never runs at any rung, which is
how you adopt eslint/tsc first and turn on the heavier three once your
baseline is clean under them.

**`verify` and the commit/push/CI gates name any analyzer that is enabled but
cannot report.** An `auto` analyzer whose provider the repo never declared runs
nothing and says nothing, so a run over such a repo would print
`clean (0 violations)` having checked almost none of it. Every one of those
rungs now ends with a line naming each skipped analyzer and the package it
needs. It is a warning, not a violation — the exit code is unchanged — but a
green run that carries it is not the guarantee it looks like. `init` prints the
same warning; the difference is that this one is in front of you every time,
not once at scaffold time.

## Mutating changed lines

The gate hands stryker the lines a change touched, not every line of every
file it touched. For each changed production file it reads the diff's hunks,
from the same diff as the changed-file list (the working tree against the base
branch, or the index for a staged commit), pads each hunk by a few lines on
each side, widens it to the function around it, and passes the result as
`--mutate "src/a.ts:120-160"`, several ranges per file where there are several
hunks. Before #155 a one-line change to a large component mutated all of it.

- **Each hunk is widened to the code around it** (#196): the innermost
  function, method, constructor, accessor or arrow function each changed line
  sits in, from its decorators and JSDoc to its closing brace, or the
  top-level statement when the line is in no function. Padding stays the
  minimum. A one-line edit can change what the rest of its function does,
  and stryker mutates only nodes wholly inside a range, so padding alone left
  that function's other mutants, and the ones spanning it, untested until CI.
- **An export the change may have orphaned is taken in**: every exported
  function, class or variable statement (or the local an `export { a }`
  names) whose name appears on a line the diff removed, in any file of the
  diff, deleted files and tests included. A change that removes an export's
  last caller leaves its mutants `NoCoverage`, outside every hunk. This is a
  deliberate superset: a name removed in one place and still called in
  another comes in all the same.
- **Both read the repo's own `typescript`.** Without it installed the gate
  warns once per run and plans padded hunks only, as before #196. A file
  typescript has no parser for (`.vue`, `.svelte`) is padded hunks only too.

- **A file new since the base is mutated whole**, and so is an untracked one.
- **A file whose padded ranges cover more than `wholeFileAbove` of its lines is
  mutated whole.** Ranges save little there and still miss the mutants across
  their edges.
- **Anything the gate cannot read goes whole too**: a file with no hunks, a path
  git quotes, a file it cannot read, or a `git diff` that fails. Ranges only
  ever narrow a file the gate was going to mutate; they never drop one.
- **The project's `!` negations** are appended after the ranges, as before.
- **Only in-range verdicts count.** Stryker writes every cached verdict into a
  ranged run's report, out of range or not, so the gate keeps only the mutants
  that lie wholly inside a planned range, the same rule stryker uses to choose
  what to mutate.

```json
{
  "mutationScope": {
    "lines": true,
    "padding": 5,
    "wholeFileAbove": 0.4,
    "enclosing": true
  }
}
```

Those are the defaults. `padding` is a whole number of lines from 0;
`wholeFileAbove` is a share from 0 to 1, where `0` mutates every changed file
whole and `1` never does. `"lines": false` turns ranges off and mutates every
changed file whole, which is the behaviour before #155. `"enclosing": false`
keeps ranges to the padded hunks, the behaviour before #196. A key of the wrong
type or out of range keeps its default. `wholeFileAbove` is applied after
widening, so a file whose changed functions make up most of it is mutated
whole.

**`lines: false` and whole-file CI.** A CI run that mutates whole files is a
superset of the gate: everything the gate tests, plus every mutant in those
files outside the planned ranges. `lines: false` makes the gate match it, at
whole-file cost, which on a real diff runs several times as long as ranges;
that is why `enclosing` widens to functions instead. The first push after upgrading runs
more mutants than the one before it; the mutation cache is not invalidated by
the change, and a cached survivor that now falls inside a widened range counts.

The defaults were checked against three ranges of this repo's own history,
using stryker's instrumenter on the modified (not new) files and leaving the
whole-file threshold out. With five lines of padding a ranged run tested 4% to
39% of the mutants a whole-file run would have, and included 83% to 97% of the
mutants that overlap a changed line. Two lines of padding included 83% to 96%
while testing 3% to 34%; ten included 89% to 99% while testing 6% to 47%.

**Known gaps.** Widening closes the in-function gap that padding left. What
it still misses, and CI's whole-scope mutation run still catches:

- A mutant in a node larger than the function, such as a `BlockStatement`
  mutant that empties a class body, when the edit is in one method.
- An edit that changes whether a mutant in a _different_ function of the
  same file, or of another file, is killed (a caller of the changed helper).
- An orphaned export in a file the diff does not change, or one changed only
  in lines the planner reads as no hunk: ranges never add a file, so the
  pre-push lock probe and the run still agree on what is mutated.
- `export default`, `export *` and re-export barrels, destructured exports,
  and dynamic access (`module[name]`): the export pass matches names, not
  references.

## The mutation cache between runs

Stryker runs with `--incremental` at every rung, so each run writes
`reports/stryker-incremental.json` for the next one to reuse. Before each run
the gate **rewrites** that file, keeping only the verdicts it can vouch for, and
stryker re-tests the rest. This matters most on the usual loop: the gate finds
survivors, an agent adds tests, the agent ships again. Before #156 every such
re-ship started cold.

What survives the rewrite under the default, `"invalidation": "targeted"`:

- **Survived and NoCoverage results are always dropped.** They are what the
  next test is written to kill, and stryker reuses a cached survivor from
  module-level ("static") code even after a killing test lands
  (stryker-js#6119).
- **A Killed result stays only if every test that killed it sits in a test file
  this change set does not touch at all**, and that was not edited after the
  cache was written. "At all" means added lines count too: a test is weakened
  by an added `return` as easily as by a removed assertion. A Timeout records
  no killer, so its covering tests stand in for one.
- **A kill whose test cannot be traced to a file is dropped.** Every other
  status is dropped too.
- **A cached file this run does not mutate is dropped.** The rest of the cache
  is kept.
- **A changed test-support module costs only the kills of the tests that
  import it.** A helper or fixture module under a test directory, or a
  `test-utils`/`test-helpers` module, is traced through the import graph, with
  the repo's own TypeScript and tsconfig (aliases included). A Killed result is
  dropped when a test that killed it imports the changed module, directly or
  through other modules, and kept otherwise. The tests asked about are the
  cache's own, plus the spec files this change set touches.

The whole cache is discarded when:

- a changed test-support file **cannot be traced** to the tests it reaches:
  - it reaches tests without an import: a setup file (`vitest.setup.ts`,
    `setupTests.ts`, `test/setup.ts`), a tool config such as
    `vitest.config.ts`, a file under `__mocks__` or `__snapshots__`, a
    snapshot, or a file that is not JavaScript or TypeScript (a
    `fixtures/*.json` a test reads as data);
  - no test imports it, so it reaches them some way the graph cannot see (a
    `setupFiles` entry under another name, an automock, a file read with
    `fs`);
  - the graph cannot be built: TypeScript is not installed, an import on the
    way resolves to nothing, a module cannot be read, or the trace passes
    `mutationCache.maxTracedModules` modules (default 5000);

  Under `any-test-change`, any changed test-support file discards the cache;

- the **fingerprint** in `reports/stryker-incremental.fingerprint.json` does not
  match. It has three parts, each holding only what can change a verdict:
  - the installed stryker version;
  - the stryker options, without the keys that cannot change how a mutant is
    judged: `mutate`, the reporters and their blocks, `thresholds`,
    `concurrency`, the log levels, the temp-directory and incremental-file
    settings, `force`, `dryRunOnly` and `$schema`. Any other key counts,
    including ones this list does not know;
  - the installed versions of the packages that run the code and its tests:
    every `dependencies` and required `peerDependencies` entry of every
    tracked `package.json`, the devDependencies that run tests (stryker,
    vitest, jest, mocha, ava, jasmine, karma, Testing Library, jsdom,
    happy-dom, the Cloudflare vitest pool, `typescript`, `tsx`, `esbuild`) and
    the names in `mutationCache.verdictDependencies`, each followed
    transitively through `node_modules`. `optionalDependencies` and optional
    peers are not followed: platform binaries live there, and a macOS checkout
    and Linux CI install different ones. Where the tracked manifests cannot be
    listed (no git), the lockfiles are hashed instead.

  So a formatter bump, or a `mutate` entry for another module, keeps the
  cache. A missing or unreadable sidecar counts as a mismatch, and the gate
  writes a fresh one before every run;

- the cache does not parse, the run cannot report per-test coverage (the
  `command` runner, or a config the gate cannot read), or no cached mutant names
  a covering test.

```json
{ "mutationCache": { "invalidation": "any-test-change" } }
```

`any-test-change` is the behaviour before #156, for repos that want it: once
any changed test is newer than the cache, the whole cache goes. Otherwise the
cache is reused as stryker wrote it, survivors included. A value the gate does
not recognise keeps `targeted`.

**Known gap: imports the graph cannot see.** The trace reads static
`import`/`export ... from`, `require('...')` and `import('...')` with a literal
specifier. A test that reaches a helper through a computed `import()` or
`require()`, or by reading a `.ts` file as text, is not counted as its
importer. If no test imports the helper at all, the cache is discarded, which
is safe; if some other test does import it, the hidden one's kills are kept.
The same goes for a setup file the runner loads under a name the gate does not
read as a setup file (`setupFiles: ['test/bootstrap.ts']`) when some test also
imports it: the gate sees only the tests that import it. Name such a file
with `setup` in it, or switch to `any-test-change`, if this matters to you.

**Known gap.** An edit in file A can change whether a mutant in an untouched
file B is killed, and the gate only mutates the files the change set touches,
so nothing at the gate re-checks B. This was true before the rewrite and is
still true after it. CI's whole-scope mutation run is the backstop: the gate
is not a complete mutation measurement.

### Seeding the mutation cache from CI (`seedFrom`)

A fresh worktree has no cache, so its first mutation run is cold, even when
CI measured nearly every mutant on the base branch an hour ago. An old
checkout on a new branch has the same problem for the files that branch
touches. If CI keeps its report somewhere you can fetch, name a command that
fetches it:

```json
{
  "mutationCache": {
    "seedFrom": "sh scripts/fetch-mutation-seed.sh",
    "seedTimeoutSeconds": 120,
    "verdictDependencies": ["@vitejs/plugin-react"]
  }
}
```

`verdictDependencies` is optional: packages whose versions can change a
verdict that the fingerprint would not otherwise count, such as a test-time
plugin outside the list above.

- **What it seeds:** per file. On every run, the seed's entries are taken for
  the in-scope files the local cache lacks, and the local entry is kept where
  both hold one. That covers a fresh worktree (every file is missing), a new
  branch in an old checkout (the files it touches are missing), and a cache
  that was just discarded (everything is missing again).
- **When it runs:** only when stryker is about to run and some in-scope file
  is missing from the local cache, because the command costs a download.
  Stryker writes no entry for a file with no mutants, so such a file in scope
  counts as missing on every run. It does not run when the run could not use a
  seed anyway: the `command` runner, no installed stryker to fingerprint, a
  changed test-support file that cannot be traced without reading the seed (a
  setup file, config, mock, snapshot or data fixture), or (under
  `any-test-change`) any changed test or test-support file. A traceable
  test-support change is judged against the seed's own tests, as it is
  against the local cache's.
- **How it runs:** `sh -c "<seedFrom>"` from the repo root, with
  `GUARDRAILS_SEED_DIR` set to an empty temporary directory. Put one or more
  stryker reports there, each with its fingerprint sidecar beside it:
  `<name>.json` and `<name>.fingerprint.json` in the same directory. Every
  `*.json` file under it, at any depth, other than a `*.fingerprint.json`, is
  read as a report. Several reports (one per CI shard) are merged. The merge
  is refused if a production file appears in two reports, if a test file
  appears at two different sources, or if any report does not parse.
- **What it checks first:** the fingerprint. Every report must have its
  sidecar, the shards' sidecars must all agree, and they must match this
  checkout's fingerprint (above). A branch that upgrades stryker, changes an
  option that judges mutants, or changes a runtime or test-stack dependency
  therefore never reuses kills CI measured under the old setup. When a seed
  is refused, the gate's line says which part differed.
- **What happens to the seed:** it passes the rules above like a local cache.
  Survivors are dropped, it is cut to this run's files, and a kill stays only
  while its test file is unchanged on this branch. (A seeded kill is not
  judged by the local cache's timestamp, which says nothing about when CI
  measured it.) It is then merged into the local cache with its test ids
  re-keyed, since each report numbers its tests from zero. A test file the
  two hold at different sources keeps the local copy, and the seed's kills by
  it are dropped. Stryker itself re-tests any mutant whose source changed.
- **When it fails** (a non-zero exit, a timeout, nothing written, a missing or
  mismatched fingerprint, or reports that cannot be merged), the run is cold
  for the files the seed would have covered, as it would have been without a
  seed, and the gate prints one line on stderr saying why. A seed never fails
  the gate. A command that runs longer than `seedTimeoutSeconds` (120 by
  default) is stopped, along with everything it started: one SIGINT, then a
  SIGKILL after `mutationLock.stopGraceSeconds`.

Guardrails ships no workflow and runs no `gh` of its own. The rest of this
section is a **sample** for GitHub Actions. Adapt it.

**The CI half:** a job on the base branch that runs stryker over the whole
scope, writes the fingerprint sidecar with `guardrails mutation-fingerprint`
(CI runs stryker itself, so nothing else writes it there), and uploads the
pair as one artifact. Keep retention short, because only the newest run is
ever read:

```yaml
# .github/workflows/mutation.yml (sample)
name: Mutation
on:
  push:
    branches: [main]
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx stryker run --incremental
      - run: node ./node_modules/guardrails-core/dist/cli.mjs mutation-fingerprint
      - uses: actions/upload-artifact@v4
        with:
          name: stryker-incremental
          path: |
            reports/stryker-incremental.json
            reports/stryker-incremental.fingerprint.json
          retention-days: 2
          if-no-files-found: error
```

Use `actions/upload-artifact` for this, not `actions/cache`. The contents of
`actions/cache` can only be restored inside a workflow run. A developer's
machine cannot download them.

**The local half** (`scripts/fetch-mutation-seed.sh`): it fetches the pair
from the run on the commit this branch forked from:

```sh
#!/bin/sh
set -eu
base=$(git merge-base HEAD origin/main)
run=$(gh run list --workflow mutation.yml --commit "$base" --status success \
  --limit 1 --json databaseId --jq '.[0].databaseId')
[ -n "$run" ] || { echo "no successful mutation run for $base" >&2; exit 1; }
gh run download "$run" --name stryker-incremental --dir "$GUARDRAILS_SEED_DIR"
```

The script picks the merge-base, not the newest run on `main`, on purpose. The
gate judges a seeded kill by whether its test file differs from the base
branch it diffs against. A report from a newer `main` can hold a kill made by
a test that `main` changed after this branch forked, and that change is not on
your branch. If no run exists for that commit (it expired, or the push was
batched), the script exits non-zero and the gate runs cold.

For a sharded CI job, run `mutation-fingerprint` in every shard and upload one
artifact per shard (`name: stryker-incremental-${{ matrix.shard }}`), then
download them all with `gh run download "$run" --pattern
'stryker-incremental-*' --dir "$GUARDRAILS_SEED_DIR"`. Each shard lands in its
own subdirectory, report and sidecar together, and the gate merges them. The
shards must split the production files between them: two shards that both
mutated one file refuse the whole seed. Every shard writes the same
fingerprint, so shards that disagree (a runner with different dependencies or
stryker) refuse it too. Every shard writes the same fingerprint because the
`mutate` array is not part of it: a shard that passes its own `--mutate`, or
a config whose `mutate` lists every shard's scope, fingerprints alike.

## Timed-out mutants

Stryker scores a `Timeout` as detected, and the gate counts it as a kill. A
mutant can time out because the machine was busy rather than because it
hangs, though, and that would be a kill no test earned. So after each stryker
run, the gate re-tests the timeouts that run measured and no test is named as
killing:

- It drops them from the incremental cache and runs stryker once more, with
  `--concurrency 1` and `--mutate` narrowed to their lines. Every other verdict
  on those lines is reused from the cache, so only they are re-tested.
- One that times out again stays a kill. One that finishes is scored as it
  finished: a survivor is reported as `stryker/survived`, and its message says
  it first timed out.
- A hit-limit timeout (`statusReason: "Hit limit reached (n/limit)"`) is not
  re-tested: stryker counted the mutant's own executions past its limit, which
  load cannot cause. Nor is a timeout reused from the cache or a seed, so a
  mutant that really hangs costs a re-test once, not on every run.
- If the re-test leaves no report (the lock was taken by another gate in
  between, or stryker crashed), the timeouts stay kills and the progress line
  says so.

The re-test is one extra stryker run, dry run included, whatever the number of
timeouts. `mutationTimeouts.retestLimit` caps how many it re-tests (default
10); the rest stay kills, and the progress line names how many were re-tested
and how many were left. `0` turns the re-test off:

```json
{ "mutationTimeouts": { "retestLimit": 0 } }
```

The run log records `retested` and `rescored` for each run that re-tested.
The re-test runs at concurrency 1, so its own timing is what its mutants cost
one after another: the row also records `retestMutatingMs`, `retestBudgetMs`
(the timeout budget stryker gave the mutants that timed out again, added up)
and `retestTimedOut`. Their difference is what a timeout costs beyond its
budget.

**What a timeout costs (#236).** Stryker gives each mutant a timeout of
`timeoutFactor × netTime + timeoutMS + the dry run's overhead`, where the
overhead is the dry run's whole time less the time its tests ran: for vitest,
mostly collecting and transforming the suite. The overhead cannot be
configured, and it grows on a loaded machine, so every mutant's budget grows
with it. After a wall-clock `Timeout` stryker also restarts its test runner
process; a hit-limit one restarts nothing. On a locked run the progress
plugin measures this, and the row's stryker part carries it as
`timeoutCost` (wall-clock and hit-limit counts, the wall-clock ones' budget,
the time each kind of result took, and the five files with the most
wall-clock timeouts, with the first and last line they start on) and
`timeoutSettings` (the `timeoutMS`, `timeoutFactor` and `concurrency` stryker
resolved, and the dry run's net time and overhead). A result's time is the
gap since the result before it, which is its own cost only at concurrency 1;
above it, `guardrails stats` estimates from the budgets instead. File paths
are relative to the repo and stay in the local run log. An unlocked run loads
no plugin and records none of this.

**What the dry run and each mutant run did (#200).** The same plugin also
records two counts-only parts in the row's stryker part. `dryRunCounts` is
how many tests stryker's dry run ran (`tests`) and in how many distinct files
(`testFiles`, absent when no test named its file). `mutantRuns` covers the
mutants stryker ran — not those reused from a cache or settled early: how
many (`ran`), the tests they ran added up (`testsCompleted`), their covering
tests added up (`coveredBy`) over the mutants that listed them
(`withCoveredBy`, so `coveredBy / withCoveredBy` is the mean), how many were
static (`static`: reached only as modules load, so stryker runs every test
for one), and `byMutator`, each stryker mutator name with its count per
status. No test name and no path is kept. `guardrails stats` prints, per
rung, the dry run's share of the lock time held (`dryRunMs` against
`lock.heldMs`, so older rows count too), the median tests per gate in the
dry run and in mutant runs, and the mutants run by mutator and status.

The dry run is already limited to related tests: the vitest runner's
`related` option is on by default, so vitest runs only the specs whose
imports reach a mutated file. What it still pays for is walking every spec's
import graph to find them. Stryker's `--testFiles` would skip that walk, but
it also makes stryker activate every mutant at runtime, which lets a static
mutant survive tests that would kill it; `test/drift/stryker-related-dry-run.test.ts`
pins both. The gate does not use `--testFiles`.

## The clean-baseline prerequisite

**Run `guardrails verify` clean before turning the gate on.** tsc, knip, and
dependency-cruiser are whole-project checks — they report every pre-existing
finding, not just ones you introduced, on every single turn. A repo scaffolded
onto a dirty baseline gets a gate that blocks every turn on findings the
adopter never wrote, which is worse than no gate at all: it trains the habit
of ignoring the gate.

```bash
node ./node_modules/guardrails-core/dist/cli.mjs verify
```

Bare `verify` runs at the **ci rung**, so it runs every enabled analyzer,
including the whole-graph ones the per-turn Stop gate skips. That is what
makes it the baseline check: it shows you everything the commit, push and CI
gates will see. It runs neither the diff-auditor nor the sanction budget —
those need a diff, and belong to `gate`.

Fix (or explicitly turn off, via `analyzers`) whatever it reports before
wiring the Stop hook into a live session, and before enabling the whole-graph
analyzers in the commit/CI gate.

## Blocking by default, `warn` for a backlog

`guardrails.config.json`'s `enforcement` field (`"block"` at the bare CLI
default, or `"warn"`) governs the branch-gate family — `gate --mode=commit`
(run by `.githooks/pre-commit`), `gate --mode=push` (run by
`.githooks/pre-push`), and `gate --mode=ci` (the step in the shipped
`.github/workflows/guardrails.yml`) — plus `gate --mode=pretooluse` (the
Copilot commit/push self-gate). Under `warn`, all of them still run the full check —
verify, the diff-auditor, the sanction budget — and print every violation and
every added suppression in full; only the exit code changes, from a blocking
non-zero to an explicit 0 with a "not blocking" note on stderr. A green run
under `warn` is never silent about violations it chose not to block on.

**This means a "required" CI check is not automatically a hard gate.** Marking
the `guardrails` job required in GitHub branch protection stops a PR from
merging only when the job actually fails — and under `enforcement: "warn"`,
`gate --mode=ci` exits 0 regardless of what it found. Flip
`enforcement` to `"block"` before a required check does anything.

**`--no-verify` is a bypass, and on the agent surfaces it is now gated.**
`git commit --no-verify` skips `.githooks/pre-commit` entirely; that flag
exists for you, and nothing takes it away from you at a terminal. What changed
is that the two agent surfaces no longer reach it silently: Copilot's
`preToolUse` `bash` matcher has run the commit gate before the command executes
since Phase B, and the scaffolded `.claude/settings.json` now carries the
equivalent `Bash` matcher (`gate --mode=pretooluse`). Both run the same check
the hook would have run, before the command, so the flag skips the git hook and
meets the gate anyway. The scaffolded instruction files also state the
prohibition outright, because in a repo an agent develops on its own there is
no human holding the bypass. Remove the `Bash` entry from
`.claude/settings.json` if you want the flag back for the agent too — with the
same caveat as the kill-switch below, that the next `init --apply` re-merges it.

**The Claude Code and Codex Stop loops are never softened by this field.** The
per-turn Stop hook (`gate --mode=stop`) always blocks on a violation, bounded
by `maxAttempts`, from the moment it is wired in — `warn`/`block` has no
effect on it. That loop's safety comes from the attempt counter and the
`--no-verify`-equivalent bypass at the commit boundary, not from `enforcement`.

A bare `init --apply` seeds `"block"`, which is what a greenfield repo, or an
existing repo that already verifies clean, wants. `warn` is only a migration
tool for an existing backlog: pass `--enforcement=warn`, let the commit/CI gate
report while that backlog is cleared, then flip to `"block"` immediately.
Letting a violation commit to the configured base branch removes it from later
diff-scoped checks, so a clean repo gains nothing from a calibration window and
can create its own dirty baseline under `warn`.

**The default used to be `warn`, and the seed is the one chance you get.**
Because `guardrails.config.json` is SEED-ONCE, `--enforcement` only affects the
_first_ time the file is written; a later `init --apply --enforcement=block` has
no effect on an already-existing config, `--force` included. Change it by
editing `enforcement` in `guardrails.config.json` directly. A repo scaffolded
before this change is sitting on `"warn"` — check the field and edit it if you
did not choose it deliberately.

### Solution-style TypeScript configurations

Vite and other project-reference layouts commonly use a root `tsconfig.json`
with `files: []` and one or more `references`. Plain `tsc -p tsconfig.json`
checks no source files in that shape and exits successfully. Guardrails detects
the references from `tsc --showConfig` and follows an apparently-clean project
check with `tsc --build --noEmit`, so referenced projects are part of the gate.
If TypeScript cannot produce a readable resolved configuration, verification
fails closed rather than treating an unknown input set as clean.

### Covering tests in the manifest (`relatedTests`)

When a gate blocks, each violation outside a test file names the test files
that cover it in `relatedTests`. That is the fixer's fast path to the test it
must strengthen, and the scope-lock lets a fixer edit exactly those tests. On
Codex, whose fixers cannot search, it is the only path.

The lookup asks your installed `typescript` which files each test imports
(`ts.preProcessFile`, then `ts.resolveModuleName` with the options of the
nearest `tsconfig.json`, or of the referenced project that includes the file).
So tsconfig `paths` aliases such as `@/lib/x` resolve the way your compiler
resolves them, and an import-shaped string in a comment is never mistaken for
an import. A test that imports a module which imports the violated file also
counts, one hop and no further.

The lookup reaches a little past what the compiler alone would accept, because
tests do:

- an import your configured resolution rejects, such as a barrel import under
  Classic resolution, is retried bundler-style, with your aliases kept;
- a relative import of a non-TypeScript file, such as `.vue` or `.svelte`,
  counts when that file exists;
- an import that resolves to a hand-written `.d.ts` names the `.js` file
  beside it;
- a workspace package linked through `node_modules` counts as the source file
  in your repo that it resolves to.

Without `typescript` installed, violations carry no `relatedTests`, and a
fixer searches for the test itself (on Codex it cannot, so it escalates more
often). The gate is unaffected otherwise. The same is true past the corpus
cap of 800 test files.

### Stacked branches: `--base`

Every diff-scoped analyzer sees `merge-base(<base>, HEAD)..HEAD`, and `<base>`
is resolved per branch rather than per repo:

1. `--base <ref>`, on `verify` and on any `gate --mode=`, when you say so;
2. the branch's pull request base, read from `gh` when it can answer;
3. the configured `baseBranch`.

This matters on a **stacked** branch — one whose PR targets another open PR.
Scoped to `main`, its range carries the parent branch's entire diff too, so
every analyzer re-runs over work that is already verified and already green in
the parent's own PR. Stryker's cost is dominated by a fixed per-invocation dry
run, so this is the difference between a half-minute run and one you kill at
half an hour.

The fallback is **silent but never narrowing**. No `gh`, no auth, no PR, a
detached HEAD, an unparseable answer — all land on the configured base, which is
_wider_ than the PR base, so a wrong answer costs time and never coverage. The
resolution itself is **not** silent: when the base is not the configured one,
`verify` and the developer-facing gate rungs say which ref they used and why.

The upstream tracking branch (`@{u}`) is deliberately not one of the sources.
For a pushed branch it is `origin/<that same branch>`, so the merge-base is the
branch's own tip and the scope collapses to unpushed commits — on a branch that
is pushed and current, to nothing at all. Fast because it checks nothing.

Cost is bounded by a per-branch memo in `.guardrails/state/base-refs.json`: one
`gh` call per branch per hour, misses included, because the Stop rung runs on
every turn.

**Do not trim `fetch-depth` on the shipped CI workflow.**
`.github/workflows/guardrails.yml` checks out with `fetch-depth: 0` on
purpose: `gate --mode=ci`'s diff-auditor and sanction budget diff against
`git merge-base <baseBranch> HEAD`, which needs history a shallow checkout
doesn't have. When that `merge-base` call fails, `branchDiff` (`gate.ts`)
falls back to `git diff --cached` — empty in a CI checkout, since nothing is
staged there. The blast radius is narrower than "CI audits nothing": eslint,
tsc, knip, dependency-cruiser, and stryker still run and can still block,
because they come from `verify`, not from the diff. What silently stops
working is only the diff-auditor and the sanction budget — a suppression
introduced on the branch sails through with no error, no warning, just a
clean-looking run. `.github/workflows/guardrails.yml` is OWNED, so a consumer
can edit it (including trimming `fetch-depth` to speed up checkout); nothing
catches that edit for you.

## Re-running `init` after an upgrade

Bump the tarball URL, run `node ./node_modules/guardrails-core/dist/cli.mjs init --plan` again. Each line is one
of:

```
create: <path> — <path> does not exist yet; creating it
update: <path> — <path> is unmodified since it was scaffolded; upgrading it
update: <path> — <path> was only reformatted since it was scaffolded; upgrading it
drift: <path> — <path> was edited after scaffolding; leaving it alone
merge: <path> — <path> is shared; merging in guardrails' entries
unchanged: <path> — ...
```

A `drift` line is a report, not a failure — the plan exits 0 and the file is
left exactly as you have it. It also prints a warning line:
`<path> has drifted from what guardrails scaffolded and was left alone (rerun
with --force to overwrite)`. Read the drift report before deciding whether to
take the upgrade's version (`--force`, which only touches OWNED files) or keep
your edit and manually reconcile.

A file your formatter rewrote is not drift. Prettier, Biome or dprint running
at commit changes whitespace, wrapping, quote characters and punctuation, but
not words. `init` compares a fingerprint of the letters and digits alone, so a
reformatted file still upgrades. The upgrade writes the template unformatted
again, and your formatter reformats it at your next commit. The trade-off: an
edit that changes only punctuation also reads as a reformat and is overwritten.
Change a word, or move the change out of the owned file, to keep it.

`--json` gives the same information as `{ actions, warnings }` for scripting.

## Codex CLI activation and trust

Codex discovers `.codex/hooks.json`, `.codex/agents/*.toml`, and `AGENTS.md`
from the repository. Start a fresh Codex session after scaffolding, run
`/hooks`, inspect the commands, and approve the repository hook hash. Codex
will not execute newly added or changed repository hooks until they are trusted.
The generated commands resolve `guardrails-core` from the Git top-level, so a
session launched in a subdirectory still uses the repository's pinned package.

## The kill-switch

To turn off the Claude Code Stop loop specifically: edit `.claude/settings.json`
and remove (or empty) the `hooks.Stop` entry that runs
`guardrails gate --mode=stop`. `.githooks/pre-commit` and the CI workflow are
untouched by this — they are separate hook/workflow files, not gated by
`.claude/settings.json` at all.

For Codex, remove (or empty) the `.codex/hooks.json` `Stop` entry that runs
`gate --mode=stop --dialect=codex`. This is likewise re-added by the next
`init --apply`, because `.codex/hooks.json` is SHARED and guardrails owns only
its own hook entries.

**This is not durable across upgrades.** `.claude/settings.json` is a SHARED
file: `init --apply` always re-merges guardrails' `Stop` entry back in on the
next run, regardless of whether you removed it, because the merger only knows
"keep every entry that isn't ours, then append ours" — it has no memory of a
prior removal. If you kill the Stop loop, expect to remove it again after the
next `init --apply`.

## Org-level surface disablement (Copilot)

An organization admin can disable the Copilot CLI or the Copilot cloud coding
agent surface outright, at the GitHub org level. No enterprise policy
specifically gates `.github/hooks` or custom agents beyond that — there is no
finer-grained switch. If an org disables one of those surfaces, the half of
the Copilot channel built on it (the CLI's or the cloud agent's `agentStop`/
`preToolUse` gating) goes inert; the git-native `.githooks/pre-commit` and CI
`verify` step still run underneath, since neither depends on the disabled
surface.

## Fixing the seeded `knip.json` before you trust the first verify

`init` seeds a deliberately conventional `knip.json` — `src/index.ts`,
`src/main.ts`, `src/**`. It is a guess, and on a framework repo it is usually
the wrong one. This is SEED-ONCE, so you edit it once and guardrails never
touches it again.

**Do this before reading the first `verify` output**, because a wrong `entry`
set does not fail loudly — it reports your real code as dead and your real
dependencies as unused, and both look like genuine findings.

- **Point `entry` at your framework's actual entries.** TanStack Start is
  `src/router.tsx` + `src/routes/**`; Next.js is `app/**`/`pages/**`; a Workers
  service is whatever `wrangler.toml` names. Measured on a real adoption: with
  the seeded guesses, `tailwindcss` was reported as an unused dependency because
  it is referenced only from CSS via `@import`/`@plugin`, which no module graph
  can see.
- **Non-npm protocol imports need ignoring.** knip reads `cloudflare:workers` /
  `cloudflare:test` as a package named `cloudflare`; a Workers repo wants
  `"ignoreDependencies": ["cloudflare"]`. Any `<scheme>:<module>` import that is
  not a real package has the same shape.

### Contracts-first repos and knip

A repo that writes contracts before their consumers exist fights knip on every
commit: deliberately-unconsumed exports are `knip/exports`, and a dependency
installed ahead of the code using it is `knip/dependencies`. Both findings are
correct — the code really is unreferenced _right now_ — so the answer is
sequencing, not suppression. Two patterns that work:

- **Land a dependency in the same commit as its first use.** Installing ahead of
  time is what creates the window where knip is right and you disagree.
- **List genuinely public API files as knip `entry`**, with a note to tighten it
  once consumers land. An `entry` is "this is a root of the graph", which is
  exactly what a public contract is — unlike an `ignore`, which says "do not
  look", and would keep the file unchecked forever.

## Generated files and the diff-auditor

Every framework that generates committed source hits this on its first commit.
TanStack Router's `routeTree.gen.ts` contains `} as any)` from the generator;
the diff-auditor reports each one as `cast-any`, and every route you add
re-adds them.

There are two grant forms, and the rule for choosing is simple: **did a human
write the suppression?**

```jsonc
// A human wrote it. Exact text, exact count, verified every run.
"sanctionedSuppressions": [
  {
    "key": "src/parser.ts|cast-any|const raw = input as any;",
    "count": 1,
    "reason": "…"
  }
]

// A generator wrote it. Whole file, one kind, no count.
"sanctionedFiles": [
  {
    "path": "src/routeTree.gen.ts",
    "kind": "cast-any",
    "reason": "Generated by TanStack Router; the casts are the generator's and the file is never hand-edited."
  }
]
```

Use `sanctionedSuppressions` for hand-written code. Its `count` must equal the
real occurrence count, which is re-derived with the auditor's own lexer and
**fails on a mismatch** — which is right, since a stale count silently
over-provisions how much the auditor stops watching.

That re-derivation runs on **every rung** — `verify`, and the commit, push and
CI gates — not only in CI. It reads files and nothing else, so it costs
milliseconds, and the point is where the failure lands: copying a granted
suppression onto a sibling line is a natural edit (the reasoning genuinely
carries over), and the commit gate cannot catch it, because it measures a key's
occurrences in the **diff** against the budget while the drift is in the
**file** total. Before this, that combination passed every local check and
failed in CI over an hour later.

Use `sanctionedFiles` for generated code, where that same discipline becomes a
chore nobody can satisfy: the count changes on every regeneration, and pinning
the exact suppression text breaks the first time the generator changes its
output shape across versions.

**What a path grant costs you.** It covers _every_ occurrence of that kind in
that file, forever, with nothing verifying it afterwards. It is scoped to one
kind — a grant for `cast-any` does not exempt a `.skip` that appears in the same
file — and to an exact path, never a glob, so it cannot silently start covering
a hand-written file added later. Its only safeguard is review, which is why
`guardrails sanctions-check` prints new path grants under their own
**WHOLE-FILE exemption** heading rather than mixed in with keyed ones. Write the
`reason` for the reviewer.

**Do not hand-write either entry — derive it.** `guardrails sanction` prints,
for every suppression that would need a grant, the exact `file|kind|text` key
(from the auditor's own lexer, so it cannot be a guess), the real `count`, a
ready-to-paste `sanctionedSuppressions` entry, what stops being checked, and how
many grants of that shape the repo already holds. Take it from a blocking
manifest with `guardrails sanction --from=<manifest>`, or from the working diff
with no flag. It writes nothing: the entry is what you bring to a human, and
there is no `--apply` on purpose — an agent installing its own exemption is the
failure this whole hatch exists to make visible.

**The counted entry is always the proposal.** Whether a file is generated is
inferred from its path and its header, which is a guess — so where the file
_reads as_ generated, the whole-file grant is printed **beneath** the counted
entry under an `ALSO CONSIDER` heading, phrased as a question for the reader.
The inference can offer the broader grant; it never chooses it. A wrong guess
therefore costs a paragraph you skip past, rather than steering you toward an
un-counted exemption that was pre-justified for you. (There is deliberately no
config list of generated paths: `sanctionedFiles` is already the human-entered
list, and a second list that has to agree with it fails worse than a heuristic.)

## Agents and slow work

Three things in a guarded repo take minutes to an hour: the push gate (which
queues behind a machine-wide lock, below), CI, and anything an agent polls
for. An agent that waits for them in the foreground pays for every minute. Its
shell call times out (ten minutes on Claude Code), it wakes, it polls again, and
each wake after the five-minute prompt-cache window re-reads its whole context.
On the adoption where this was measured, background agents spent about 27% of a
weekly usage limit waiting.

The cheap shape depends on the host:

- **Claude Code:** run the wait with `run_in_background: true` and end the turn.
  Claude Code wakes the agent once, when the command exits.
- **Codex and Copilot CLI:** they can run a command in the background (Codex's
  background terminals, checked with `write_stdin`; Copilot's async and detached
  `bash` modes, checked with `read_bash`), but as far as we observed (Codex 0.154
  and Copilot CLI, at time of writing) neither wakes the agent when it exits, so
  every check is another model call that re-reads the whole context. Don't wait
  inside the agent at all: start the job detached (`nohup node ./node_modules/guardrails-core/dist/cli.mjs ship … >
ship.log 2>&1 &`), finish the task, and let whoever started the agent read
  `.guardrails/state/ship-status.json`. If your host gains wake-on-exit, the
  Claude pattern applies.

- **`guardrails ship`** is the one command to background. It runs the push
  gate (`gate --mode=push`, through the repo's own guardrails-core, exactly as
  the pre-push hook does), then `git push -u origin HEAD`, finds the branch's
  pull request or opens one (`--body-file=<f>`, else `gh pr create --fill`),
  waits with `gh pr checks --watch --fail-fast`, and writes
  `.guardrails/state/ship-status.json` (`--status-file=<f>` to move it):
  `{state, branch, pr, url, failing, tail, finishedAt, warnings, diagnosis}`. `state` is
  `green`, `preflight-failed` (with the failing command), `gate-blocked`,
  `lock-timeout`, `ci-red` (with the failing check names), `behind`,
  `conflicting` (with the conflicted files) or `error`. It
  prints one line and exits 0 only on green. The watch ends at the first
  failed check, so `ci-red` names it while slower checks are still running.
  Before pushing, and so before the gate lock, ship fetches the base and
  refuses a branch that does not contain `origin/<base>`: `conflicting` when
  it would not merge cleanly, `behind` when it would. Rebase and ship again.
  If the base cannot be fetched, ship pushes anyway and says so in
  `warnings`.
  The gate runs before the push so that its wait for the lock holds no
  connection to the remote open: a remote that drops an idle connection
  cannot turn a gate verdict into a transport error. The gate's exit decides:
  a block is `gate-blocked`, with each finding in `failing` as
  `<file>:<line> <rule>` or `<file>:<line> added <kind>`; a lock timeout is
  `lock-timeout`; a gate that was killed, could not start or exited oddly is
  `error`. Nothing is pushed on any of them, and HEAD must not move while the
  gate runs. On a pass the pre-push hook's gate finds that pass recorded
  (`cached: true`) and returns at once. There is no flag or variable that
  tells the hook to skip: if the record misses, the hook gates in full during
  the push, as before. A connection that drops during the push after a green
  gate is `error`, and its tail says to ship again. The gate checks the
  working tree, untracked files included, but git pushes HEAD, so
  uncommitted or untracked paths at ship time are named in `warnings`.
  Known limit: with `enforcement: "warn"`, or when an analyzer was skipped,
  the gate records no pass, and the hook gates the push again in full.
  Checks are
  not the only thing it reads: a workflow run on the pushed commit that ended
  `startup_failure`, `failure`, `timed_out` or `cancelled` is `ci-red` and is
  named in `failing` as `<workflow> (<conclusion>)`, because a workflow that
  fails to start creates no checks at all. A cancelled run does not count when
  another run of the same workflow on that commit was not cancelled. A check the base branch requires
  (by ruleset or branch protection) that never reported is `ci-red` too, as
  `<check> (required, not reported)`, after about two minutes of waiting.
  On `ci-red`, `diagnosis` says what to do next, from evidence only
  (`null` in every other state): `base` is whether `origin/<base>` still is
  in the pushed commit, asked again after CI (`contains`, `moved`, or
  `unknown` with a warning); `rerunnable` is the `gh run list` ids of the red
  runs with failed jobs to re-run (never a check-run id from a link); and
  `advice` is `rebase` when the base moved, else `rerun-failed` when there is
  a run to re-run, else `fix`. The summary line prints it as `next: …`. Ship
  never calls a failure flaky.
- **`guardrails ship --rerun-failed`** pushes nothing. It re-derives the runs
  from a fresh `gh run list` for HEAD, runs `gh run rerun <id> --failed` on
  each (after `gh run watch <id>` for a run still going, which GitHub cannot
  re-run), waits for each run's attempt to advance, then watches and
  diagnoses the checks as a ship does: one background command, one status.
  It refuses, re-running nothing, when HEAD is not the commit `origin` has
  for the branch, when there is no pull request, when no red run has jobs to
  re-run (`error`), and when the base moved since the commit was tested
  (`behind`). Ship never re-runs on its own.
  After the push, ship asks `origin` whether the branch is at the commit it
  pushed. If it is not, ship pushes once more and says so in `warnings`; if it
  still is not, the state is `error` and no checks are read. It needs
  `gh`, authenticated, and checks that before pushing: a missing or logged-out
  `gh` is an `error` that says how to fix it, and nothing is pushed.
  `ship --help` prints all of this and pushes nothing.
- **Cheap checks before the gate (`ship.preflight`).** The push gate waits
  for the machine-wide lock, so a check that runs after it -- a build, a fast
  test run, chained after `sh .githooks/pre-push` in your own hook -- is found
  red only once the lane has paid for that wait. List such checks in
  `guardrails.config.json` instead:

  ```json
  { "ship": { "preflight": ["npm run build", "npm test"] } }
  ```

  ship runs them after its own checks (gh, the body file, the base) and
  before the gate, each with `sh -c` from the repository root and stdin
  closed, in order, stopping at the first to fail. One that exits non-zero
  ends the ship as `preflight-failed`: `failing` names the command, `tail`
  holds the last 40 lines of its output, and nothing is pushed or gated. One
  that is killed or cannot start is `error`. After they pass, HEAD must
  still be the commit ship is about to gate. An entry that is not a
  non-blank string is dropped and named in `warnings`. Missing, empty or
  malformed, the key runs nothing, and ship behaves as before.
  `--rerun-failed` never runs them. A lane acts on `preflight-failed` the
  way it acts on `gate-blocked`: it fixes what the command reported, commits,
  and ships again.

  The scaffolded pre-push hook runs the same list with
  `guardrails preflight --mode=hook`, before its gate line, so a plain
  `git push` checks it too. A pass is recorded in
  `.guardrails/state/preflight-pass.json`, keyed by the tree fingerprint
  (tracked and untracked files, the merge-base, the guardrails-core version),
  the base ref, a hash of the command list and the Node version. It is
  written only when every command passed and the tree was the same after
  them as before. With `--mode=hook` a matching record skips the commands,
  which is what happens when ship's push fires the hook, and ship itself
  honours it, so a ship retried on the same tree skips them too.
  `guardrails preflight` without the flag always runs them and refreshes the
  record. It exits 0 when they passed, when nothing is configured, or (hook
  mode) when the record matched; it exits 1 when one failed, was killed or
  could not start, ending its output with
  `guardrails: push stopped — preflight "<cmd>" failed`, which ship reads
  as `preflight-failed` if the hook stops a push.

  Limits: the record cannot see environment variables, the network, or
  tools outside the repository, so a command whose result depends on them
  does not belong in the list; CI stays authoritative. A message-only amend
  keeps the record (the tree is the same); an amend that changes content
  runs the commands again. A command that reads output an earlier hook step
  writes (a coverage report, say) must not move ahead of that step.

- **A new pull request's title** is `--title=<t>` when given, else the body
  file's first line when it is `# <title>` (that line is dropped from the
  body), else the last commit's subject. Ship sets it only when it opens the
  PR; it never changes an open one. When the last commit's subject is used and
  its conventional type differs from the one the branch's prefix names (a
  `fix/` branch, a `docs(...)` subject), `warnings` says so and names the
  `gh pr edit` that retitles it. A squash merge keeps the title, so a trailing
  docs or test commit would otherwise label the change on the base too.
- **A branch rebased after its first push** needs `--force-with-lease`; ship
  never forces on its own. Without the flag, git's rejection comes back as an
  `error` whose tail ends with a line naming the flag.
- **`--attach=<file>[#alt text]`** (repeatable) attaches an image or video: to
  a new pull request as it is opened, or to an open one as a comment, posted
  again on each run. An upload that fails never changes `state`; it lands in
  `warnings` and on the printed line.
- **The PreToolUse hook enforces it.** On Claude Code's `Bash`, without
  `run_in_background: true`, and on the Codex and Copilot shell tools, it denies `gh pr checks … --watch`,
  `gh run watch`, an `until`/`while` loop polling `kill -0` or `pgrep`, a
  `sleep` longer than `foregroundSleepLimitSeconds` (default 120), and
  `guardrails ship`. The denial says what to do instead. Set
  `"denyForegroundWaits": false` in `guardrails.config.json` to turn it off.
  The denial is per host: Claude is told to background it and end the turn;
  Codex and Copilot are told to start it detached and finish. Detached means
  both halves: `nohup …` or `setsid …` at command position _and_ a trailing
  `&`. A bare `… &` still ties the job to the shell, and `nohup` without the
  `&` still waits, so both are denied. Wrappers that detach nothing (`nice`,
  `time`, `env`, `command`, `exec`, `timeout`, `stdbuf`, `ionice`,
  `caffeinate`, `VAR=value`) are seen through. `run_in_background` is a Claude
  flag and excuses nothing elsewhere.
- **A retried push is cheap.** The push gate remembers the last tree it passed,
  with its base, in `.guardrails/state/push-pass.json`. Pushing the same tree
  against the same base again (after a rejected ref, a dropped connection, a
  rebase that changed nothing) skips the analyzers and says `cached: true`. A
  new byte, a moved merge-base, another base ref or another guardrails-core
  version runs it again.
- **A push is gated once, not twice.** The PreToolUse hook no longer runs the
  commit-rung gate before a `git push` whose pre-push hook (as git resolves it,
  `core.hooksPath` included) runs `gate --mode=push`. A push that also commits,
  carries `--no-verify` or overrides the hooks path is still gated there.
- **One mutation run at a time, per machine.** The gate holds a
  file-descriptor lock (`lockf` or `flock`) around the stryker run itself, on
  every rung that runs it, so agents in several worktrees queue for mutation
  testing instead of thrashing the machine together -- and a commit or push
  with nothing to mutate never queues at all. `GUARDRAILS_GATE_LOCK` names the
  lock file (default `$HOME/.guardrails-gate.lock`, shared by every repo on the
  machine). How long each rung waits is `mutationLock` in
  `guardrails.config.json`: the stop rung tries once and defers to commit,
  commit waits `commitWaitSeconds` (60) and defers to push, push waits
  `pushWaitSeconds` (10800; `GUARDRAILS_GATE_LOCK_TIMEOUT` still sets it when
  the key is absent) and then blocks with `guardrails: gave up waiting for the
gate lock`, which `guardrails ship` reports as `lock-timeout` rather than as
  a block. While a run waits it names the holder and its progress -- e.g.
  `dialed-163 (push) is mutating, 62% (160/258), ~4m left` -- and how many
  others queue, once a minute. `guardrails lock-status` shows the same once,
  from anywhere on the machine.
- **Anything else that loads the machine takes the same lock with
  `guardrails lock`.** `guardrails lock [--timeout=<seconds>] -- <cmd> [args…]`
  waits for the gate lock (`mutationLock.pushWaitSeconds` by default;
  `--timeout=0` tries once), runs the command, streams its output, and exits
  with its code -- or 75, with the same `gave up waiting for the gate lock`
  line, when the wait runs out. Use it for a whole-repo stryker run, a build
  or a benchmark instead of wrapping one in `lockf`/`flock` by hand: a gate
  queued behind it reads `app is running npm under guardrails lock, 12m so
far` rather than `another checkout holds it`. The command runs with
  `GUARDRAILS_GATE_LOCK_HELD` set to the lock's path, so a gate or a nested
  `guardrails lock` inside it (`guardrails lock -- git push`) runs at once
  instead of queueing behind its own parent. With no `lockf` or `flock`, or a
  lock file it cannot open, it runs the command unserialized and says so.
- **A stopped mutation run keeps what it tested.** When the gate is stopped
  mid-run (by a signal, or at its hook deadline) it sends the locked stryker
  run exactly one SIGINT, and stryker writes a partial
  `reports/stryker-incremental.json` that the next run reuses. A second
  signal would make stryker exit without saving (stryker-js#6257). Whatever
  stops the gate may also signal stryker directly, as a tree-kill does, so
  guardrails' progress plugin absorbs any repeat inside stryker. A run still
  alive `mutationLock.stopGraceSeconds` (30) after the SIGINT is SIGKILLed,
  so a hung one cannot hold the lock.
- **Every gate and ship is logged, machine-wide.** Each commit and push gate,
  each stop turn that mutated something, and each `guardrails ship` appends
  one JSON line to `<lock>.runs.jsonl`, beside the gate lock (so
  `$HOME/.guardrails-gate.lock.runs.jsonl` by default, shared by every repo).
  A gate's row has its outcome (`pass`, `block`, `defer`, `lock-timeout`),
  how long it queued for the lock and held it, who held it and how many
  waited when it arrived, whether stryker started warm (a kept local cache
  or a used seed) and, if not, why, the dry-run and mutating times, the
  mutant, timeout, survivor and no-coverage counts, and the load average and
  free memory at the start and the end. A ship's row has its push time (gate
  included), its gates' time (ship's own gate and the hook's, summed), its CI
  time, the PR and the final state. A `guardrails lock` run's row
  (`kind: "lock"`) has the command's basename and a hash of its whole
  command line (never the argument values), its exit code and any signal,
  its outcome (`ran`, `lock-timeout`, `unserialized`, `already-held`, or
  `killed` when it was stopped), and how long it queued and held the lock.
  Counts come from stryker's JSON report, which the gate always asks for;
  `report: "missing"` means the run left none. The times come from
  guardrails' progress plugin, so a run without the built plugin has counts
  but no phase times. Writing the log never fails a gate or a ship.
- **`guardrails stats`** summarizes the log for the last week
  (`--since=24h`, `--since=90m`), for every repo or one (`--repo=<name>`):
  per rung, the queue and hold times, the dry-run and mutating times
  (median and p90), how many runs started warm and why the rest went cold;
  per ship, the final states and the push, gate and CI times; per
  `guardrails lock` run, the outcomes, queue and hold times and commands; per
  rung, what its timeouts cost (see "What a timeout costs"); and the
  dry-run time by queue depth on arrival and by load per core at the start,
  which is what decides whether the machine can afford more concurrent
  lanes. `--json` prints the same as JSON.

A `CLAUDE.md` snippet for adopters:

```markdown
## Slow work runs in the background

- Ship with `node ./node_modules/guardrails-core/dist/cli.mjs ship`, run with
  `run_in_background: true`, then end your turn. You are woken once when it
  exits; read `.guardrails/state/ship-status.json` for what happened.
- Never wait in the foreground: no `gh pr checks --watch`, `gh run watch`,
  `sleep` loops, or `kill -0`/`pgrep` polling. Background it and end the turn.
- Anything that may take over two minutes (the full test suite, mutation
  testing, a build) runs in the background too.
```

An `AGENTS.md` snippet for Codex and Copilot (both read it). Verify the
wake-on-exit claim against your host version; if it gains one, use the Claude
snippet instead:

```markdown
## Slow work: don't wait inside the agent

As of Codex 0.154 / Copilot CLI at time of writing, neither wakes the agent when
a background process exits, so each check of one is another model call that
re-reads your whole context. Never poll a background terminal or loop in the
foreground (`sleep`, `kill -0`/`pgrep`, `gh pr checks --watch`, `gh run watch`)
for a job that takes minutes. Up to about 2 minutes is fine.

- Commit your work first. Then start the slow part detached and finish the task:
  `nohup node ./node_modules/guardrails-core/dist/cli.mjs ship --body-file=<f> > ship.log 2>&1 &`. It pushes,
  opens or finds the PR, watches CI, and writes
  `.guardrails/state/ship-status.json`.
- End your reply by saying what is running and where its outcome will land.
  The person or coordinator who started you reads that file; a failure goes to
  a fresh task, given the failure output and the diff.
```

**Coordinating several agents.** What made a lane expensive was waiting in
the foreground and re-paying its context on every wake. `guardrails ship` in
the background costs one wake per ship, and the machine-wide lock already
makes pushes take turns, so each lane ships itself:

- A lane ships with `guardrails ship --body-file=<f>` under
  `run_in_background`, ends its turn, and is woken once with one status.
- A lane that is still active fixes its own `preflight-failed`,
  `gate-blocked` or `ci-red` from
  the status file's `tail` and `failing`. On `lock-timeout` it runs
  `guardrails ship` again, which re-queues. On `behind` or `conflicting` it
  rebases onto the base and ships again with `--force-with-lease` if the
  branch was already pushed. On `ci-red` it reads `diagnosis.advice`: on
  `rebase` it rebases and ships again; on `rerun-failed`, when it judges the
  failure not to be in its change, it backgrounds
  `guardrails ship --rerun-failed` instead of hand-rolling `gh run rerun` and
  its wait.
- The coordinator merges and cleans up. For a lane whose work is finished, it
  hands a failure to a **fresh** fixer agent with the failure output and the
  diff, rather than reviving the lane's large context.

(Up to 0.12.0 this section said lanes stop at "ready to ship" and only the
coordinator pushes. That rule guarded against foreground waits, which the
PreToolUse hook now denies; `upgrades/` records the change for upgraders.)

## Known limits

Things worth knowing before you hit them, rather than after:

- **`complexity` scopes by file, not by line.** A finding is kept when its
  function's file is in your diff, so touching one line of a file that already
  holds an over-threshold function reports that function, as ESLint does for a
  touched file. Fix it, or add it to `health.ignore` in your fallow config if it
  is a deliberate exception. Scoping to the changed lines is a possible
  follow-up.

- **In-repo trees that are not part of your module graph must be excluded
  yourself.** knip and dependency-cruiser walk the repository, so a vendored or
  `third_party` directory, generated output, or a large fixture tree gets
  reported as your code. Nested git worktrees are the one case handled for
  you — `verify` drops any violation resolving inside a worktree that
  `git worktree list` reports, wherever it lives, and the scaffolded
  `.gitignore` and dependency-cruiser seed both exclude `.claude/worktrees/` so
  the analyzers do not waste time walking it. Everything else is yours to
  exclude; `adopting-guardrails` step 4 prompts for it. A first `verify` that
  reports findings by the hundred almost always means an analyzer is scanning
  something that is not your code — check the paths before fixing anything.
- **A graph installed past npm's peer check is reported, not tolerated.**
  `guardrails/peer-range-violation` runs at the commit rung and asks
  `npm ls --json` which installed packages violate another package's peer
  range. That catches what `--legacy-peer-deps`, `--force`, and workspace
  hoisting hide — a graph that installs cleanly and misbehaves later. It
  reports `invalid` versions only; a missing optional peer is not a finding,
  and each violation is reported once however many paths reach it. The case
  that motivated it: `npm i -D typescript` installs a major no released
  typescript-eslint accepts, so a strict TypeScript stack cannot be assembled
  without pinning TypeScript below that ceiling. Set `"npm-peers": "off"` in
  `analyzers` if your package manager is not npm.
- **Whether a running fixer confines your other agents depends on the host.**
  The violations manifest is keyed by session, and a subagent shares its
  parent's session id — so the scope-lock narrows to the fixer only where the
  host reports which agent is calling.

  | surface         | during a fix, the main agent and sibling subagents are…                                                                                             |
  | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **Claude Code** | unaffected — `agent_id` appears only inside a subagent, so its absence identifies the main thread and a non-fixer `agent_type` identifies a sibling |
  | **Copilot**     | confined — `preToolUse` carries no agent fields                                                                                                     |
  | **Codex**       | siblings unaffected (they report `agent_type`); the main thread confined until the session's fixer has reported its own identity, then unaffected   |

  On Copilot, a fan-out of unrelated subagents during a fix is locked to the
  fixer's manifest, and the main agent cannot edit outside it either, so a fix
  cycle blocks the turn rather than overlapping with it. Codex has sent
  `agent_id`/`agent_type` for thread-spawned subagents since
  `openai/codex#22882`, but its main-thread payload is identical to what an
  older Codex sent for every agent, fixer included. So a missing `agent_id`
  reads as "main thread" only after a fixer in the same session has shown one;
  before that, the main thread stays confined. That is the conservative
  direction on purpose: Codex has no per-agent tool allowlist, so the hook is
  its only enforcement.

  A commit-gate block opens the same lock for the fixer it names. On Copilot
  and Codex that means the session is confined to the commit manifest's files
  (and the tests the manifest names) until a commit passes, or for at most 30
  minutes, after which the loop is treated as abandoned.

- **A git write is gated in the repository it lands in, which the hook has to
  work out from the command.** The hook payload names the directory the shell
  started in, but `cd ../other && git commit` commits in `../other`. The
  PreToolUse gate reads a narrow set of literal shapes to find the target:
  a `cd` chain joined to the write by `&&`, `;` or a newline (absolute,
  relative, quoted, `~`), and every `git -C <dir>`. Same-install writes, such
  as a `cd` into a subdirectory, gate in-process as before. A write that lands
  in another repository is handed to that repository's own guardrails-core,
  so its config, its pinned version and its tree decide. If that repository
  has a `guardrails.config.json` but no install of its own, the write is
  denied with an `npm ci` remedy naming it. If it never adopted guardrails,
  the write is allowed, and its own git hooks still run.

  Anything it cannot read for certain is denied rather than guessed at, since
  a guess gates the wrong repository. That covers a `cd` to a variable or a
  substitution, `cd -`, `pushd`/`popd`, a `cd` inside a subshell, group,
  pipeline, `||` or `&`, `--git-dir`/`--work-tree` and
  `GIT_DIR=`/`GIT_WORK_TREE=`, and one command writing into two directories.
  The remedy is always a literal path: `cd <dir> && git ...` or
  `git -C <dir> ...`. `$(...)` and backticks elsewhere in the command, such as
  a `-m "$(cat <<'EOF' ...)"` message, do not affect the answer. Out of reach,
  as they always were: `xargs git commit`, `sh -c '...'` and git aliases. The
  Stop gate and the git hooks need none of this, because they already run in
  the repository being written.

- **Every host lets a timed-out hook through.** Claude Code, Codex and Copilot
  all treat a hook timeout as fail-open, so a gate that is still running when
  the host gives up has decided nothing. The scaffolded wiring gives every gate
  a 300-second hook timeout. The CLI keeps its own, shorter deadline
  (`hookDeadlineSeconds` in `guardrails.config.json`, default 240) and decides
  before the host does: a git write it could not finish checking is denied, a
  Stop is let through with a note on stderr, and its analyzers are stopped. If
  you raise a hook `timeout`, raise `hookDeadlineSeconds` with it. Copilot's
  own default is 30 seconds, which is why the Copilot wiring sets `timeoutSec`
  explicitly.
- **A worktree needs its own install.** A checkout nested inside another one
  (Claude Code puts subagent worktrees in `.claude/worktrees/`) resolves the
  parent's `guardrails-core` when it has no `node_modules` of its own. The CLI
  refuses to guard with a copy the checkout did not install. A git commit or
  push there is denied, and a Stop is blocked once, both with the remedy (`npm
ci` in that checkout). Every other tool call passes through untouched. The
  git hooks say the same and still block.
- **On Codex and Copilot the Stop gate checks the agent's current
  directory.** Claude Code exposes the session's root (`CLAUDE_PROJECT_DIR`),
  and the Stop gate verifies that rather than wherever the shell last went.
  The other hosts expose no such root, so an orchestrating agent that `cd`s
  into another checkout has that checkout verified at its next Stop.

- **The seeded `stryker.conf.json` trips knip.** Its starter `testRunner` is
  `"command"`, and knip reads that file, resolves the runner, and reports
  `@stryker-mutator/command-runner` as an unlisted dependency — in exactly the
  knip-plus-stryker combination worth recommending. Swapping `command` for the
  framework runner you actually use (`@stryker-mutator/vitest-runner`, say),
  which you want to do anyway, clears it. `stryker.conf.json` is SEED-ONCE, so
  editing it is safe: `init` will never touch it again.
- **Do not set `thresholds.break` in `stryker.conf.json`.** guardrails reads
  stryker's report and raises one violation per surviving mutant, diff-scoped
  to the files your change touched — that is the gate. `break` asks a
  whole-project-score question instead and answers it with a non-zero exit,
  which adds no check guardrails is not already making and fails on survivors
  in files your change never went near. Set `low`/`high` to have the score
  reported if you want it; leave `break` unset. (Guardrails now reads the
  report on a non-zero exit rather than treating one as a crash, so a `break`
  threshold no longer _hides_ your mutants the way it did — but it still
  reports a failure that is not the one being asked about.)
- **Root config files written in TypeScript are not mutation-tested.**
  `vitest.config.ts`, `eslint.config.mts`, `playwright.config.ts` and anything
  else matching `*.config.*ts` are excluded from stryker's `--mutate` set.
  Every mutant they produce is `NoCoverage` by construction — a config literal
  is read by a tool at startup, never by a test — so including them handed the
  fixer violations no honest fix could clear. eslint and tsc still check these
  files; only mutation skips them.
- **A file class no test can import belongs in `stryker.conf.json`'s `mutate`,
  negated.** Some frameworks own files outright: a TanStack Start route or
  server function resolves only inside the framework's own runtime, so no unit
  test can import it and every mutant in it comes back `NoCoverage` — work no
  fixer can honestly do. Exclude it once, with a `!` entry in your config's
  `mutate` array (`"src/routes/**,!src/routes/api/**"`, or a separate
  `"!src/modules/*/functions.ts"` entry — both shapes work). Guardrails reads
  those negations and passes them through on every run, so the file is out of
  scope for the commit gate for the same reason it is out of scope for your
  ratchet, and you keep the analyzer everywhere else. Only the JSON config
  forms (`stryker.conf.json`, `.stryker.conf.json`) are read; a config in
  `stryker.conf.mjs` or under a `package.json` key gets no negations passed
  through. Pair the exclusion with an architecture test that keeps those files
  trivial — imports, wiring and delegation only — or the exclusion becomes a
  place for logic to hide. One shape will not carry: a negation with a comma
  inside a brace expansion (`"!src/**/{foo,bar}.ts"`). Stryker's own CLI splits
  `--mutate` on commas with no brace awareness, so that pattern cannot survive
  the hand-off however it is encoded; write the two negations out separately.
  Guardrails drops the fragment rather than passing its unnegated half through,
  so the cost is a negation that does not apply, never a widened mutation set.
- **`.claude/settings.json` is reformatted on every merge**, unconditionally
  (see the SHARED-file note above). If your formatter disagrees with the
  merger's output, expect a reformat/re-reformat cycle on every `init --apply`.
  Cosmetic, not destructive.
- **Two findings on one line read as a duplicate.** The `Violation` contract
  carries a line but no column, so two genuinely different findings at the same
  line — two mutants on one expression, two eslint reports on one statement —
  print as identical rows. They are not duplicates and must not be collapsed:
  each is its own fix. Read the count as "findings", not "distinct lines".
- **Orphan files are never reported or removed.** A file an earlier guardrails
  version wrote that a later version no longer wants to write (renamed,
  retired) is left in place silently, and its checksum entry in
  `.guardrails/scaffold.json` is never dropped by a later `--apply`. This is
  deliberate — deleting a file inside your repository needs a design of its
  own (what if you edited it first?) — but it means a stale file from an old
  install can outlive every upgrade until someone removes it by hand.
- **The scaffolder assumes a clean baseline** (see above) — it will happily
  scaffold onto a repo with pre-existing `verify` findings, and the gate it
  wires up will then escalate on those findings from turn one.
- **An `auto` analyzer whose provider you never installed is skipped in
  silence.** `init` seeds an empty `analyzers` block, which makes every
  analyzer `auto`: it runs if its binary resolves, and a failure to resolve is
  an error only when your own `package.json` declares the provider. So a repo
  that never installed eslint gets no eslint checking and a `verify` that
  prints `clean (0 violations)`. `init --plan` and `--apply` now warn, naming
  each analyzer and the package it needs — read that warning before you accept
  a green first run. The fix is either half: install the tool, or mark it
  `"required"` so its absence blocks instead.
- **Declared analyzer providers are read from the ROOT `package.json` only.**
  A monorepo that declares eslint/typescript/knip/dependency-cruiser/stryker in
  its member packages rather than at the root has an empty declared set: every
  analyzer is `auto`+undeclared, so a broken install degrades to "skipped"
  silently instead of erroring, which is the opposite of what you want. The
  workaround is one line — mark those analyzers `"required"` in
  `guardrails.config.json`, which states the dependency explicitly and restores
  the hard `guardrails/analyzer-missing` error.
