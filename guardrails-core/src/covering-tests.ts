/**
 * The test files that exercise a violated file, worked out for the fixer.
 *
 * A fixer handed `stryker/survived` at `src/verify/index.ts:902` has to find
 * the test that covers that line before it can strengthen one. Nothing told it
 * where to look, and two recorded runs died trying: one spent 33 of 47 reads
 * on `File does not exist`, guessing names like `stryker-mutate-positives.
 * test.ts`; the other paged a 4187-line test file in overlapping windows
 * (plan.md, "fixer-loop hardening"). `Grep` now makes the search possible;
 * this makes it usually unnecessary, by answering the question in the manifest
 * the fixer already reads — the same channel, and the same reasoning, as
 * `guidance`.
 *
 * Matched on the IMPORT GRAPH rather than on a filename convention, because
 * convention is precisely what failed. The tests for `src/verify/index.ts`
 * live in `test/verify/orchestrator.test.ts`, whose name contains neither the
 * module nor the symbol; any `<name>.test.ts` rule would have missed it, and
 * a substring rule would have attributed `src/a.ts`'s tests to `src/ab.ts`.
 * Which files a text imports is TypeScript's answer, not a pattern's
 * (`import-graph.ts`, #120): a comment is never an import, and a tsconfig
 * `paths` alias resolves the way the compiler resolves it.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';

import type { ImportResolver } from './import-graph.js';
import { isTestFile } from './verify/git.js';
import type { Violation } from './violation.js';

/**
 * The entries of `testFiles` whose contents import `target`, sorted so the
 * manifest is byte-stable across runs.
 *
 * `target` and the map's keys are repo-relative POSIX paths, the shape a
 * `Violation.file` already carries.
 */
export function coveringTests(
  target: string,
  testFiles: ReadonlyMap<string, string>,
  imports: ImportResolver,
  readSource?: (file: string) => string | undefined,
): string[] {
  const direct = [...testFiles]
    .filter(([testFile, contents]) =>
      imports(testFile, contents).includes(target),
    )
    .map(([testFile]) => testFile);
  const found =
    readSource === undefined || direct.length > 0
      ? direct
      : testsOneHopAway(target, testFiles, imports, readSource);
  return found.toSorted((left, right) => left.localeCompare(right));
}

/**
 * The tests that import a module which imports `target` -- used only when no
 * test imports `target` itself.
 *
 * A helper extracted into its own file is exercised through its parent's
 * tests, which import the parent. With direct importers alone, a fixer handed
 * that helper's surviving mutants was pointed at no test, and the scope-lock
 * -- which makes a violation's related tests editable -- left it unable to
 * edit the one file that would kill them. Extraction is the fix fixers reach
 * for on a duplication finding, so this was not a corner case.
 *
 * One hop only: every further hop widens what a fixer may edit, on evidence
 * that gets weaker each time. Each module a test names is read at most once.
 */
function testsOneHopAway(
  target: string,
  testFiles: ReadonlyMap<string, string>,
  imports: ImportResolver,
  readSource: (file: string) => string | undefined,
): string[] {
  const importsTarget = new Map<string, boolean>();
  const isBridge = (module: string): boolean => {
    let answer = importsTarget.get(module);
    if (answer === undefined) {
      const contents = readSource(module);
      answer =
        contents !== undefined && imports(module, contents).includes(target);
      importsTarget.set(module, answer);
    }
    return answer;
  };
  return [...testFiles]
    .filter(([testFile, contents]) =>
      imports(testFile, contents).some((module) => isBridge(module)),
    )
    .map(([testFile]) => testFile);
}

/**
 * Directories a repository's test corpus is never in, and walking them is the
 * difference between a walk and a hang. `node_modules` alone can hold hundreds
 * of thousands of files, many of them named `*.test.ts`.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'reports',
  '.stryker-tmp',
  '.next',
  '.turbo',
]);

/**
 * How many test files are worth reading at gate time.
 *
 * The whole corpus is read to answer one manifest, so this is the cost ceiling
 * on a hint. A repo above it gets no `relatedTests` and its fixer greps
 * instead, which is the behaviour that shipped before this existed — the hint
 * is an optimisation, and an optimisation that stalls the gate is worse than
 * no hint.
 */
const MAX_TEST_FILES = 800;

/**
 * Size ceiling per file, for the same reason: a generated or fixture-bearing
 * test file can be megabytes, and its imports are no more informative than a
 * small one's.
 */
const MAX_TEST_BYTES = 512 * 1024;

function isReadableSource(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(file);
}

/**
 * The ceilings a corpus read is bounded by. Injectable so the boundaries are
 * testable at three files rather than at eight hundred.
 */
export interface CorpusLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: CorpusLimits = {
  maxFiles: MAX_TEST_FILES,
  maxBytes: MAX_TEST_BYTES,
};

/**
 * Every test file in the repo, as repo-relative POSIX path → contents.
 *
 * Unreadable entries are skipped rather than thrown on: this runs inside the
 * gate, and a permission error on one file must not take down the block the
 * fixer is waiting for. Same for the whole read hitting a ceiling — a repo
 * past the cap simply gets no hint, and its fixer greps.
 */
export function readTestCorpus(
  repoRoot: string,
  limits: CorpusLimits = DEFAULT_LIMITS,
): Map<string, string> {
  const corpus = new Map<string, string>();
  collectTestFiles(repoRoot, repoRoot, corpus, limits);
  return corpus;
}

function collectTestFiles(
  repoRoot: string,
  directory: string,
  corpus: Map<string, string>,
  limits: CorpusLimits,
): void {
  for (const entry of directoryEntries(directory)) {
    if (corpus.size >= limits.maxFiles) {
      return;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        collectTestFiles(repoRoot, absolute, corpus, limits);
      }
    } else {
      addTestFile(repoRoot, absolute, corpus, limits);
    }
  }
}

/**
 * An unreadable directory contributes nothing rather than throwing.
 */
function directoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function addTestFile(
  repoRoot: string,
  absolute: string,
  corpus: Map<string, string>,
  limits: CorpusLimits,
): void {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  if (!isTestFile(relative) || !isReadableSource(relative)) {
    return;
  }
  const contents = readWithinLimit(absolute, limits.maxBytes);
  if (contents !== undefined) {
    corpus.set(relative, contents);
  }
}

function readWithinLimit(
  absolute: string,
  maxBytes: number,
): string | undefined {
  let contents;
  try {
    contents = readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
  return contents.length <= maxBytes ? contents : undefined;
}

/**
 * Return `violations` with `relatedTests` set where the file has covering
 * tests.
 *
 * The corpus and the resolver are each loaded once, lazily: a manifest whose
 * violations are all in test files, or one with no violations at all, loads
 * neither -- so a clean gate never loads TypeScript. Violations already
 * carrying the key are left alone, and a file with no importer gets no key —
 * an empty array would claim "searched, none exist", which is a different
 * thing from "not computed" and would stop a fixer looking. No resolver (no
 * TypeScript installed) means no key on anything, for the same reason.
 */
export function withCoveringTests(
  violations: readonly Violation[],
  loadCorpus: () => ReadonlyMap<string, string>,
  loadImports: () => ImportResolver | undefined,
  readSource?: (file: string) => string | undefined,
): Violation[] {
  let loaded:
    | typeof NO_RESOLVER
    | {
        readonly imports: ImportResolver;
        readonly corpus: ReadonlyMap<string, string>;
      }
    | undefined;
  const byFile = new Map<string, readonly string[]>();
  return violations.map((violation) => {
    if (violation.relatedTests !== undefined || isTestFile(violation.file)) {
      return violation;
    }
    // The resolver first: without one there is nothing to ask, and the
    // corpus -- up to 800 test files -- would be read only to be discarded.
    loaded ??= loadBoth(loadImports, loadCorpus);
    if (loaded === NO_RESOLVER) {
      return violation;
    }
    let related = byFile.get(violation.file);
    if (related === undefined) {
      related = coveringTests(
        violation.file,
        loaded.corpus,
        loaded.imports,
        readSource,
      );
      byFile.set(violation.file, related);
    }
    return related.length === 0
      ? violation
      : { ...violation, relatedTests: related };
  });
}

/**
No TypeScript to ask, so nothing is attributed.
*/
const NO_RESOLVER = 'no-resolver';

function loadBoth(
  loadImports: () => ImportResolver | undefined,
  loadCorpus: () => ReadonlyMap<string, string>,
):
  | typeof NO_RESOLVER
  | {
      readonly imports: ImportResolver;
      readonly corpus: ReadonlyMap<string, string>;
    } {
  const imports = loadImports();
  return imports === undefined
    ? NO_RESOLVER
    : { imports, corpus: loadCorpus() };
}
