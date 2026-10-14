# Covering-test lookup on TypeScript's scanner and resolver (#120)

## Goal

Replace the regex specifier scan (`RELATIVE_SPECIFIER`) and the hand-written
candidate list (`resolutionsOf`) in `guardrails-core/src/covering-tests.ts`
with TypeScript's own `ts.preProcessFile` and `ts.resolveModuleName`.

- **What it fixes:** imports found inside comments and prose, the cause of #118.
- **What it adds:** path aliases (`@/lib/x`), `baseUrl`, and `package.json`
  `imports`, all of which currently produce no `relatedTests`.

If `typescript` is not installed, the lookup adds no hint. It never crashes.

## Shape

- **`import-graph.ts` (new): the only module that touches `typescript`.**
  It exposes:
  `createImportResolver(repoRoot): ((fromFile, text) => string[]) | undefined`.
  - **Returns:** the repo-relative POSIX paths of the in-repo files that `text`
    imports. `undefined` means `typescript` could not be loaded or no tsconfig
    could be parsed.
  - **Loading:** `createRequire(path.join(repoRoot, 'package.json'))('typescript')`,
    so the consumer's own install is used. Loading happens lazily, on the first
    call, and is synchronous because `forTheFixer` is synchronous.
  - **Types:** `import type` only, from this repo's devDependency. Nothing from
    it is imported at runtime.
  - **Compiler options:** from `ts.findConfigFile` + `readConfigFile` +
    `parseJsonConfigFileContent`.
    - A solution-style root (`files: []` plus `references`) has each referenced
      project parsed too.
    - A file is resolved with the options of the first project whose
      `fileNames` include it. A file in no project uses the root's options.
    - No tsconfig at all means default options: `node10` resolution with
      `allowJs`. Relative imports still resolve; only aliases are lost.
  - **What it drops:** results with `isExternalLibraryImport`, results outside
    the repo, and `.d.ts` files.
  - **Caching:** one `ts.createModuleResolutionCache` per project.
  - **Errors:** every throw from `typescript` is caught per call, and an
    erroring call reads as "imports nothing".
- **`covering-tests.ts`**
  - `coveringTests(target, testFiles, imports, readSource?)` takes the resolver
    in place of the regex and `resolutionsOf`.
  - The direct match becomes `imports(testFile, contents).includes(target)`.
  - The one-hop lookup reads each imported module once and checks
    `imports(module, text)`.
  - `RELATIVE_SPECIFIER`, `SPECIFIER_ENDINGS`, `BARE_EXTENSIONS` and
    `resolutionsOf` are deleted.
  - `withCoveringTests` takes the resolver factory. If the factory returns
    `undefined`, every violation is returned without `relatedTests`.
- **`gate.ts:forTheFixer`** passes `createImportResolver(repoRoot)` through. It
  is evaluated lazily, inside the same "is there a non-test violation" path
  that loads the corpus today, so a clean gate never loads `typescript`.

## Steps (TDD, each one green on its own)

1. **Resolver, relative imports.**
   - **Tests** (`test/import-graph.test.ts`, tmp repos with a real tsconfig):
     - a `.js` import of a `.ts` file;
     - an extensionless import;
     - a barrel-directory import;
     - `require()`;
     - dynamic `import()`;
     - `export … from`;
     - an import-shaped string inside a comment, a template literal or prose,
       which is ignored (#118's input);
     - a bare package import (`vitest`), which is dropped.
   - **Done when:** all pass, against this repo's own `typescript`.
2. **Resolver, configuration.**
   - **Tests:**
     - a `paths` alias;
     - `baseUrl`;
     - a solution-style root whose alias lives only in a referenced project;
     - a repo with no tsconfig, where relative imports still resolve;
     - a broken tsconfig, which gives `undefined` or default options without
       throwing.
3. **Resolver, absence.**
   - **Test:** `typescript` cannot be required, because `repoRoot` sits in a
     tmp dir with no `node_modules` reachable. The result is `undefined`, with
     no throw.
   - **Check:** the tmp dir must really be outside every `node_modules` on the
     way up. Assert it, so the test cannot pass vacuously.
4. **Switch `covering-tests.ts` to the resolver.**
   - **Tests:** the existing `coveringTests` tests are ported to inject a fake
     resolver, so the direct, one-hop, at-most-once-read, sorting and
     prefer-direct behaviours keep their tests.
     - The #118 tests move to step 1, where the scanner is real.
     - New: a resolver that returns `undefined` leaves violations with no key.
   - **Done when:** the regex and `resolutionsOf` are gone, and knip and fallow
     find nothing dead.
5. **Wire up `gate.ts`, and check the result against the old lookup.**
   - **Test:** an integration test through `forTheFixer`'s public path, with a
     tmp repo where a violation's covering test reaches it only through an alias.
   - **Manual check:**
     - Run the old and new lookups over every `src/**/*.ts` in this repo and
       diff the results.
     - The new results must be a superset, or every difference must be a regex
       false positive that is now gone.
     - Record the diff in the PR.
6. **Docs.** `docs/adoption.md`:
   - `relatedTests` now needs `typescript`, and follows tsconfig `paths`;
   - the no-`typescript` behaviour.

   Also update `plan.md`'s roadmap entry.

## Risks

- **Load time.** The first lookup in a gate run loads `typescript`, about
  200–400 ms. This only happens on a gate that is already blocking. I'll measure
  it in step 5 and put the number in the PR.
- **TypeScript API drift.** `preProcessFile` and `resolveModuleName` have been
  stable since TS 2. The peer range is `>=5`. The drift suite gets a case that
  runs the real API against a fixture, in the same style as the stryker-runner
  guard in CLAUDE.md.
- **Workspaces.** Within one monorepo package, its own tsconfig is found by
  `findConfigFile` from that package's directory, not from the repo root. Step 2
  adds a test with a nested package tsconfig. If it gets complicated, I'll fall
  back to the root and record the gap.

## Release

Hold 0.7.1 or 0.8.0 until this merges, per the developer.

- #119 by itself is a patch.
- Together with this, I'd call it 0.8.0: the lookup's results change, and it
  now depends on `typescript` at runtime.
