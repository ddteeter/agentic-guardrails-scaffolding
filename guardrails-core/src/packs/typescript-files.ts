/**
 * Which files are TypeScript's (GR-02): the predicates the TypeScript pack
 * answers `isSourceFile`, `isTestFile` and `isConfigFile` with. They lived
 * in `verify/git.ts` until the pack seam; the bodies are unchanged.
 *
 * A leaf module, apart from the pack object in `typescript.ts`:
 * `covering-tests.ts` asks `isTestFile` and the pack wraps
 * `covering-tests.ts`, so the two cannot be one file.
 */

export function isTypeScriptFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
}

/**
 * Test material: a `*.test.ts`/`*.spec.ts` file, OR any file living under a
 * test directory.
 *
 * The directory half exists because a suite is not only its spec files. A
 * helper module a test imports -- a fixture builder, a harness, a shared
 * predicate -- carries no `.test.` in its name, so the extension rule alone
 * classed it as PRODUCTION and handed it to stryker, which then reported
 * `no-coverage` on a module no test asserts about directly and no fixer can
 * honestly do anything with. Found by dogfooding, on this repo's own
 * `test/drift/under-mutation.ts`.
 *
 * The segment must be the WHOLE directory name (`test/`, `tests/`,
 * `__tests__/`), not a substring: `src/testing/latest.ts` is production, and a
 * rule that swallowed it would silently stop mutating real code.
 */
export function isTestFile(file: string): boolean {
  if (/\.(test|spec)\.tsx?$/.test(file)) {
    return true;
  }
  return file
    .split(/[/\\]/)
    .slice(0, -1)
    .some((segment) => TEST_DIRECTORIES.has(segment));
}

export const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
]);

/**
 * Config-as-TypeScript: `vitest.config.ts`, `eslint.config.mts`,
 * `playwright.config.ts`, and every other `*.config.*ts` a modern TypeScript
 * repo declares its tooling in.
 *
 * These are TypeScript and are not named `*.test.ts`, so a plain
 * "TypeScript minus tests" production filter classes them as mutable source.
 * Every mutant they yield is `NoCoverage` by construction — a config literal is
 * read by a tool at startup, never by a test — so mutation-testing them hands
 * the fixer violations no honest fix can clear, and the only exits left are a
 * sanctioned suppression or a stryker `mutate` exclusion the adopter has to
 * know to write. Excluded from MUTATION only: eslint and tsc still check these
 * files, which is where their real defects surface.
 */
export function isConfigFile(file: string): boolean {
  return /(^|\/)[^/]*\.config\.[cm]?tsx?$/.test(file);
}
