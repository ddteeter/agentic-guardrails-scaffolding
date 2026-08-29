# Phase C, piece 5 — workspaces / affected-package attribution — Design

The last piece of Phase C. Turns on the monorepo half of the contract that has
been declared since Phase A but never wired.

## 0. TL;DR

- **Attribution only.** Derive each violation's owning package from its file path
  and set `Violation.package`. This activates the per-package recurrence memory
  the contract already specifies (`package:ruleId`).
- **Run-scoping is explicitly NOT in this piece.** Deciding which packages a
  change affects and running analyzers over only those is a separate concern with
  a different risk profile, and it cannot be validated here — see §6.
- **Hybrid resolution.** Declared workspace members when the root `package.json`
  declares `workspaces`; nearest-ancestor `package.json` otherwise.
- **`picomatch` as a BUNDLED devDependency** for glob matching. It has zero
  transitive dependencies, and tsup inlines it, so consumers still install
  `guardrails-core` with an empty dependency tree.
- **The dead `packageId` seam is deleted** from all five adapters.

## 1. The problem

`Violation.package` and `recurrenceKey`'s `package:ruleId` form have existed
since Phase A. Nothing sets them. `packageId` is threaded as a parameter through
`parseEslintJson`, `parseTscOutput`, `parseKnipJson`, `parseDepcruiseJson` and
`parseStrykerJson`, and **no caller has ever passed it** — a forward-declared
seam that neither knip nor fallow can see, because it is a parameter rather than
an export.

The consequence in a monorepo: a rule recurring in one package is tallied against
the bare `ruleId`, so it is diluted across the whole repo. Recurrence-as-signal —
the auto-promotion mechanism — measures the wrong thing.

A single `packageId` per run could never have fixed this: attribution is
**per-file**, and one `verify` run spans files in many packages.

## 2. Resolution: hybrid

`loadWorkspaceResolver(repoRoot)` returns a pure `(file: string) => string |
undefined`. It reads the filesystem once at construction; every lookup after that
is pure.

**Declared mode** — the root `package.json` has a `workspaces` field, in either
the npm/yarn array form or yarn's `{ "packages": [...] }` object form. Those globs
are matched with `picomatch`; only matching directories that contain a
`package.json` count as packages.

This is correct by construction for the case that motivated it: this repo's
`guardrails-core/test/drift/knip-fixture/package.json` is **not** a declared
member, so a file under it attributes to `guardrails-core`, not to a phantom
package. Nearest-ancestor alone would get that wrong.

**Fallback mode** — no `workspaces` declaration: walk up from the file to the
first directory containing a `package.json`, stopping at `repoRoot`. This covers
pnpm, nx, turbo, lerna and plain folder layouts with no per-tool knowledge.

**Root-owned files resolve to `undefined`**, so no `package` key is added and
single-repo behaviour is byte-identical to today.

### What the identifier is

The package id is the **repo-relative directory path** — `guardrails-core`,
`packages/api` — not the `name` field from its `package.json`.

A directory path is always present, always unique, and derivable without reading
every member's manifest; a `name` can be missing, private, duplicated across a
malformed workspace, or absent from a plain-folder monorepo entirely. It also
matches how `Violation.file` is already reported, so a reader can line the two up
without a lookup table. `recurrenceKey` therefore produces keys like
`packages/api:no-console`.

### Nesting and failure behaviour

When more than one candidate matches a file — a package nested inside another
package's directory — the **deepest** match wins, in both modes.

Resolution degrades rather than throws, matching `config.ts`'s defensive parsing:
an unreadable or malformed root `package.json` falls back to nearest-ancestor
mode; an unreadable directory yields `undefined`; a file resolving outside
`repoRoot` yields `undefined`. Attribution is an enrichment, so it must never be
able to fail a gate that would otherwise pass.

### Non-goal: parsing `pnpm-workspace.yaml`

Deliberate. It would mean a YAML dependency or a fragile hand-parse, and pnpm
packages all carry a `package.json`, so the fallback already resolves them
correctly. The same reasoning retires `@manypkg/get-packages` (§3).

## 3. Dependency decision

`guardrails-core` currently ships **zero runtime dependencies** — it installs into
a consumer repo with no transitive supply chain. That property is worth
protecting, particularly for a security-adjacent tool whose Dependabot config
already imposes a 7-day supply-chain cooldown.

Surveyed empirically (versions and trees as published, checked this session):

| Library                  | License | Tree                                                                     |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `@manypkg/get-packages`  | MIT     | ~7 total (`@manypkg/tools`, `find-root`, `jju`, `tinyglobby`, `yaml`, …) |
| `@npmcli/map-workspaces` | ISC     | 4 direct (`glob`, `minimatch`, …); npm-only, no pnpm                     |
| `find-workspaces`        | MIT     | 3 direct (`fast-glob`, `yaml`, …); still 0.x                             |
| `workspace-tools`        | MIT     | 6 direct (`js-yaml`, `git-url-parse`, …)                                 |
| **`picomatch`**          | MIT     | **zero**                                                                 |

**Chosen: `picomatch`, as a devDependency.** It removes the only genuinely tricky
part — glob semantics — while the parts we keep (reading a JSON field, walking up
a directory tree) are a few lines each. It is the matcher underneath `fast-glob`,
`micromatch` and Vite.

`@manypkg/get-packages` was rejected despite better package-manager coverage,
because **it does not remove the fallback**: it handles package-manager
workspaces, not nx/turbo/plain-folder monorepos, so that path still has to be
written and tested. Its one advantage over the fallback — parsing
`pnpm-workspace.yaml` — buys nothing the fallback does not already do. It costs
the most and deletes the least.

### Bundling (verified empirically)

`guardrails-core/tsup.config.ts` sets no `noExternal`, and tsup externalizes only
`dependencies`/`peerDependencies`. Verified this session with a throwaway probe:
importing the existing devDependency `@eslint/js` from `src` and building inlined
its source into `dist/index.mjs`, with no external import emitted. So a
devDependency reaches consumers as bundled code and **`dependencies` stays
empty**.

Two consequences:

- picomatch's unusually narrow `engines` (`^22||^24||>=26`, excluding odd-numbered
  Node lines) affects only our own dev install, never a consumer's. The repo pins
  Node 24 via `.nvmrc` and CI, which the range includes. Note `engine-strict=true`
  in `.npmrc` makes a mismatch a hard error, so a contributor on a non-LTS Node
  will need to follow `.nvmrc` — as they already should.
- Bundling MIT code carries an **attribution obligation**. Implementation must
  confirm the license notice survives into `dist`, and add it explicitly if
  esbuild's legal-comments handling drops it.

## 4. Attribution

`withPackages(violations, resolve): Violation[]` mirrors `withGuidance` exactly:
map, set `package` from `file`, leave an already-set value alone, add no key when
there is no owning package. Being idempotent and preserve-existing makes it safe
to apply at more than one point.

Applied in:

- **`runVerify`**, so every analyzer violation is attributed and the `verify`
  command benefits, not just the gates.
- **`gate.ts`**, composed with `withGuidance`, so audit-derived violations — which
  also carry files — are attributed too.

Then `packageId` is **removed** from all five adapters. It is dead, and leaving it
beside a mechanism that works would present two ways to express one thing, one of
them a trap. The adapters are internal (not exported from `index.ts`), so nothing
external breaks.

## 5. What this activates

`recurrenceKey` already returns `package:ruleId` when `package` is set, so
per-package recurrence memory turns on with no change to `state-store` or
`gate-decision`. It needs a test proving the same rule in two packages tallies
**separately** rather than merging — that behaviour is the entire point of the
piece and is currently unexercised.

## 6. Why run-scoping is deferred

Scoping analyzer runs to affected packages is where the real monorepo pain is
(`tsc` over fifty packages on every commit). It is deferred because it needs a
workspace dependency graph, per-package tool-config resolution, and downstream
traversal — and because **it is an optimisation that cannot be measured here**.
Attribution is behavioural and testable; run-scoping without a real monorepo to
measure against would be speculative work validated by nothing.

## 7. Testing

Temp-directory fixtures, in the style of `config.test.ts` and `scope.test.ts`:

- declared globs (`packages/*`), `**`, and `!` negation
- yarn's `{ packages: [...] }` object form
- the stray-manifest case — a nested `package.json` that is not a declared member
- fallback mode with no `workspaces` declaration
- root-owned files → no `package` key
- files outside any package, and paths that escape `repoRoot`
- a package nested inside another package: the deepest match wins
- a malformed root `package.json`: degrades to fallback mode, does not throw
- `withPackages`: idempotence, preserve-existing, order and field preservation
- recurrence: the same `ruleId` in two packages tallies separately

## 8. Risks and open items

- **This repo has ONE workspace, so the multi-package path is exercised by tests
  only, never live.** The same product-lens gap as the mutation adoption ramp:
  dogfooding cannot validate this piece. That argues for keeping it small and
  behavioural — resolution plus attribution — rather than clever, and for
  resisting run-scoping until a real monorepo exists to measure.
- **Attribution correctness is load-bearing.** A wrong `package` silently
  corrupts recurrence memory, which is worse than no attribution at all. Hence
  declared-members precision over nearest-ancestor reach wherever a declaration
  exists.
- **Bundled-license attribution** must be confirmed in `dist` (§3).
