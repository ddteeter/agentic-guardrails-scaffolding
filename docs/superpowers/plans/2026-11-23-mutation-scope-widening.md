# Plan: #196 — widen the push gate's changed-line mutation scope

Approved by the owner 2026-11-23, with the decisions below.

## Owner decisions

1. An orphaned export in a file OUTSIDE the change set does not pull that file in (ranges never change the file set; the pre-push lock probe relies on that). Document as a miss.
2. Widen to the INNERMOST enclosing function-like node.
3. Add `mutationScope.enclosing` (boolean, default `true`). `false` keeps today's padding-only ranges. Wire through `pickMutationScope` + config tests + docs.
4. Orphan logic brings in the export's DECLARATION only (not the whole file).
5. When `typescript` can't be loaded, print a one-time warning that ranges are padding-only.

## Findings

- `planRunRanges` (src/verify/mutate-ranges.ts) runs `changedLineRanges` (`git diff --unified=0 --diff-filter=ACM`) → `parseDiffHunks` → `planMutateRanges` → `planFileRanges`/`padAndMerge`. Called once at src/verify/index.ts:~1963; the same `lineRanges` map feeds `mutateEntries` (`--mutate file:a-b`) AND the verdict filter (`parseStrykerJson`/`unrunSurvivedMutants` via `isLocationInRanges`), so widening inside `planRunRanges` widens both.
- Only .ts/.tsx reach stryker (`strykerScope` → `isTypeScriptFile`, src/verify/git.ts:~169). Extension fallback is for safety.
- src/import-graph.ts already loads the consumer's own `typescript` (optional peer) via `createRequire(repoRoot/package.json)` with an injectable `load`, returning `undefined` when absent. No new dependency. `ts.createSourceFile` is error-tolerant.
- Cache: cache-fingerprint.ts does not hash `mutationScope` or ranges (mutate is on the no-verdict denylist). No invalidation; first push after upgrade runs more mutants. Cached survivors newly in range will count — intended.
- `--unified=0` already carries `-` lines; `parseDiffHunks` skips them. Part (b) reads them from the same diff, but deleted files are dropped by `--diff-filter=ACM` today.

## Design

(a) For each hunk, innermost function-like node containing it (function decl/expr, arrow, method, constructor, accessor); else the top-level statement containing it. Range = union(hunk ± padding, node's full lines; use `getStart(sf, true)`-style start so decorators/JSDoc lines are included). Multi-node hunks take each node. Merge as today; `wholeFileAbove` applies AFTER widening. Fallback to padding-only: typescript absent, no ScriptKind for the extension, file unreadable, or `enclosing: false`.
(b) Identifier tokens from every `-` line in the whole change set (including deleted files and test files). For each ranged file, parse head, list exported declarations (exported function/class/variable statements; `export { a }` resolved to the local decl). Add full lines of every exported declaration whose name is in the token set. Deliberate superset — no "last reference" check.
Misses (document): export in an unchanged file; `export default`; `export *` barrels; dynamic access; dependents in callers in other functions.

## Steps (TDD each: red → green → eslint + tsc clean)

1. Shared TS loader: move loadFromRepo/loaded/type guard from import-graph.ts into src/typescript-loader.ts (parse guard checks `createSourceFile`; resolver keeps its own guard). Test: undefined from a tmp repo without typescript; a module from this repo. Existing import-graph tests unchanged and green.
2. `enclosingSpans(ts, fileName, text, hunks): LineRange[] | undefined` in src/verify/enclosing-spans.ts. Tests: one-line hunk in a 30-line function → whole function; nested arrow → arrow only; top-level const object → statement; hunk across two functions → both; pure-deletion hunk → enclosing function; .vue → undefined; .tsx/.js parse; decorated method includes decorator line.
3. `planFileRanges` takes optional spans as an extra minimum. Tests: spans outrank padding; padding still applies when span smaller; large span trips wholeFileAbove. Existing tests unchanged.
4. `removedIdentifiers(diff): Set<string>` from `-` body lines only (not `+`, not headers). Widen to `--diff-filter=ACMD`; test that deleted files feed the set and still get no ranges (`+++ /dev/null` → undefined, pin it).
5. `orphanedExportSpans(ts, file, text, names): LineRange[]`. Tests: exported fn whose only call was removed in another changed file → whole declaration; name not removed → nothing; `export { a }` → a's decl; non-exported local with same name → nothing.
6. `mutationScope.enclosing` config key (default true) + `pickMutationScope` + config tests.
7. Wire into `planRunRanges` with a `loadTypescript` seam; read text once per file. Tests (fake exec): widens to function; loader undefined → equals today's plan + one-time warning; `enclosing: false` → today's plan. Real-repo test in mutate-ranges-git.test.ts: delete caller file → callee decl in range.
8. Verdict-filter regression: cached survivor inside widened function now counts; outside still dropped. mutation-scope-wiring test shows widened `--mutate` entries.
9. Docs: module doc comment (closes most of its KNOWN GAP), docs/adoption.md (known gap, `enclosing`, `lines: false` vs whole-file CI, parser fallback, misses list), upgrades/unreleased.md (behaviour changed: survivors/no-coverage on untouched lines in the same function may now appear; first push runs more mutants; cache not invalidated. Supersedes: instructions treating a gate survivor on an untouched line as stale. Wire: nothing; `enclosing: false` / `lines: false` as opt-outs).

## Risk to measure

Push-gate time rises. Before release, replay the #155 history sample with and without `enclosing` and put the numbers in adoption.md (can be a follow-up if it needs real gate runs; say so in the PR).
