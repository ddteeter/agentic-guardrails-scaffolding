# Seed fingerprint: key on what can change a verdict (#177)

## Problem

`computeFingerprint` (`guardrails-core/src/verify/cache-fingerprint.ts`) is
three fields: the stryker version, the sha256 of the whole stryker config
text, and the sha256 of every lockfile. A local cache or a seed whose sidecar
differs in any of them is discarded. So a prettier bump, or a `mutate` entry
added for another module, makes every branch's next push gate cold.

## Design

The fingerprint stays three fields, renamed so an old sidecar cannot be read
as a new one (an old sidecar is then unparseable, which is already "cold"):

| field                           | today                                     | after                                                                                                |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `stryker`                       | installed `@stryker-mutator/core` version | unchanged                                                                                            |
| `options` (was `config`)        | sha256 of the config text                 | sha256 of the config with the keys that cannot change a verdict removed, serialized with sorted keys |
| `dependencies` (was `lockfile`) | sha256 of every lockfile                  | sha256 of `name@installed-version` for the packages that run the code or the tests                   |

**`options`.** A denylist, not an allowlist, so a key this list doesn't know
(a new stryker option, a plugin's block) still invalidates: wrong costs a cold
run, never a wrong verdict. Removed: `mutate` (it chooses which files are
mutated, never how a mutant is judged; the gate already intersects it with
the change set), `reporters` and the per-reporter blocks (`htmlReporter`,
`jsonReporter`, `clearTextReporter`, `dashboard`, `eventReporter`),
`thresholds`, `concurrency`, `logLevel`, `fileLogLevel`, `allowConsoleColors`,
`tempDirName`, `cleanTempDir`, `incremental`, `incrementalFile`, `force`,
`dryRunOnly` and `$schema`. Kept, among others: `mutator`, `timeoutMS`,
`timeoutFactor`, `testRunner` and its block (`vitest`, `jest`, …),
`coverageAnalysis`, `checkers`, `plugins`, `ignorers`, `ignoreStatic`,
`disableTypeChecks`, `buildCommand`. A config that isn't a JSON object is
hashed whole, as today.

This drops the whole `mutate` array instead of keeping "each scope's own
entry" as the issue sketches: no `mutate` entry can change a verdict, so
there is nothing to keep, and the seed's report already says which files it
holds.

**`dependencies`.** Mirrors the intent of dialed.run's `mutation.yml` digest
without importing it: every runtime dependency counts (a zod or drizzle bump
can flip a verdict), and of the devDependencies only the test stack does. The
differences are what make it consumer-generic:

- Versions are read from the **installed** `node_modules/<name>/package.json`
  (Node's upward walk, as `installedStrykerVersion` already does), not from
  one package manager's lockfile, so npm, pnpm, yarn and bun are one code
  path. A package that isn't installed is `name@missing`.
- Names are `dependencies` and `peerDependencies` of every tracked
  `package.json` (`git ls-files`, so npm, yarn and pnpm workspaces are one
  path, and nested worktrees and sandboxes are never read), plus the
  devDependencies (anywhere) that match the test stack: `@stryker-mutator/*`,
  `vitest`, `@vitest/*`, `jest`, `@jest/*`, `ts-jest`, `babel-jest`, `mocha`,
  `ava`, `jasmine`, `karma*`, `@testing-library/*`, `jsdom`, `happy-dom`,
  `@cloudflare/vitest-pool-workers`, `typescript` (stryker's TypeScript
  checker turns a type error into `CompileError`), `tsx`, `esbuild`.
- `mutationCache.verdictDependencies` (optional, in `guardrails.config.json`)
  adds names for a repo whose test stack isn't on that list.
- No `package.json` at the root: the lockfile hash, as today.

**Not `optionalDependencies`, and not optional peers.** That is where platform binaries live
(`@esbuild/darwin-arm64`, `@rollup/rollup-linux-x64-gnu`): a macOS checkout
and Linux CI install different ones, so counting them would make a CI seed
never match a local checkout. The parent package's version, which those
binaries follow, still counts. Optional peers (`peerDependenciesMeta`) are
not followed either: one flips from missing to installed whenever an
unrelated tool pulls it in, and a project that uses one lists it itself.

**Measured:** 60 ms over 385 packages here, 70 ms over 598 in dialed.run.

**Transitively.** From each counted package, its own `dependencies` and `peerDependencies`
are followed through
`node_modules` the way Node resolves them (the nearest `node_modules/<name>`
at or above the depending package's real path, so pnpm's symlinked layout
resolves too), and every package reached is hashed as `name@version`, sorted.
So a lockfile-only bump of anything the runtime or test stack pulls in still
invalidates, as the lockfile hash did; what drops out is the dependency tree
of tools that run neither the code nor the tests (prettier, eslint, fallow
and their dependencies). A package that does not resolve is `name@missing`
and is not walked further. dialed.run's digest counts direct dependencies
only; this is stricter than that on purpose.

**Which part differed.** The seed-miss message ("measured under another
stryker version, stryker config or lockfile") names the fields that differed,
e.g. `…measured under another stryker version (9.2.0, here 9.3.0)` or
`…other dependency versions`. #176's log reads this.

## Steps

Each step is test-first, small, and green before the next.

1. **Options digest.** `verdictOptions(configText)` in
   `cache-fingerprint.ts`: parses, drops the denylisted keys, serializes
   with sorted keys; non-object input is returned unchanged. Tests: a
   `mutate`, `reporters` or `thresholds` change gives the same digest; a
   `mutator`, `timeoutMS`, `testRunner`, `vitest.configFile`, `checkers`
   change, or an unknown key, gives a different one; key order doesn't
   matter; non-JSON text is hashed whole. _Done:_ unit tests green.
2. **Dependency digest.** `verdictDependencies(manifests, installedVersion)`
   (pure: takes the parsed manifests and a version lookup) plus a reader in
   `prepare-cache.ts` that loads the root and workspace manifests and reads
   installed versions upward from the repo root. Tests: a prettier or eslint
   version change keeps the digest; a runtime dependency, a vitest or a
   stryker plugin change alters it; a workspace member's runtime dependency
   counts; a transitive dependency of a counted package counts, and one of
   an uncounted package does not; a cycle terminates; a package resolves
   from the nearest `node_modules` above its real path (a nested copy wins
   over a hoisted one); a missing package is `@missing`;
   `verdictDependencies` from config adds a name; no root manifest falls
   back to the lockfile hash. Measure the walk on this repo and note the
   time.
   _Done:_ unit tests green.
3. **Fingerprint v2.** `computeFingerprint`, `parseFingerprint` and
   `isFingerprintEqual` move to `{stryker, options, dependencies}`; a v1
   sidecar parses as `undefined`. _Done:_ `cache-fingerprint.test.ts`,
   `prepare-cache.test.ts` and `seed-cache.test.ts` green.
4. **Name the difference.** `fingerprintDifference(recorded, current)`
   lists the differing fields; `seed-cache.ts`'s message uses it. _Done:_
   the seed tests assert each field's wording.
5. **Real-stryker drift check.** Extend `test/drift/stryker-timeout.test.ts`'s
   seeded run, or add a sibling: a seed measured on `main`, then a branch
   that adds a `mutate` entry for another file and bumps an unrelated
   devDependency's installed version, still seeds (the progress line says
   so). _Done:_ the drift test is green under the gate lock.
6. **Docs.** `docs/adoption.md`'s `seedFrom` section, the config key in the
   config reference, and `upgrades/unreleased.md`: the first run after the
   upgrade is cold once, because old sidecars no longer parse, and CI must
   run the new `guardrails mutation-fingerprint` before seeds match.
   _Done:_ `upgrade-notes-files.test.ts` green.

## Not in scope

- Hashing the test runner's own config file (`vitest.config.ts`). Today's
  fingerprint doesn't include it either, so leaving it out is no
  regression; including it would widen invalidation, the opposite of this
  issue.
- Anything in dialed.run's workflow. Adoption is a separate session.

## Runtime cost

One small `package.json` read per package in the counted closure (hundreds
to a few thousand), in place of reading and hashing the lockfiles. Step 2
measures it.
