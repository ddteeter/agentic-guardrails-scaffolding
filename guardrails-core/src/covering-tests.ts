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
 * A specifier is resolved the way the runtime resolves it and compared as a
 * path, so the answer is right or absent, never approximate.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';

import { isTestFile } from './verify/git.js';
import type { Violation } from './violation.js';

/**
 * Every relative specifier in a source text.
 *
 * One pattern for `import`, `export ... from`, `require()` and dynamic
 * `import()` alike, because all four wrap the specifier in quotes and only the
 * leading `.` matters here. Deliberately not a parser: a quoted relative path
 * that is not an import resolves to a file the target either is or is not, and
 * a false positive means naming one extra test file — the cost of being wrong
 * is a hint, not a fix.
 */
const RELATIVE_SPECIFIER = /['"](\.[^'"\n]*)['"]/g;

/**
 * Extensions a specifier may be written with, mapped to what it can mean on
 * disk. ESM TypeScript names the EMITTED file (`./a.js` for `a.ts`), so the
 * literal specifier usually does not exist as written.
 */
const SPECIFIER_ENDINGS: readonly (readonly [string, readonly string[]])[] = [
  ['.js', ['.ts', '.tsx', '.js']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.mjs', ['.mts', '.mjs']],
  ['.cjs', ['.cts', '.cjs']],
];

/**
 * Extensions an extensionless specifier may resolve to, in resolution order.
 */
const BARE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
];

/**
 * Every repo-relative path a specifier could denote, written with POSIX
 * separators to match the git-relative paths a violation carries.
 */
function resolutionsOf(fromFile: string, specifier: string): string[] {
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  const ending = SPECIFIER_ENDINGS.find(([suffix]) => joined.endsWith(suffix));
  if (ending !== undefined) {
    const [suffix, replacements] = ending;
    const stem = joined.slice(0, -suffix.length);
    return replacements.map((replacement) => `${stem}${replacement}`);
  }
  return [
    joined,
    ...BARE_EXTENSIONS.map((extension) => `${joined}${extension}`),
    // A directory specifier: `./verify` meaning `./verify/index.ts`.
    ...BARE_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
  ];
}

function isImportingTarget(
  testFile: string,
  contents: string,
  target: string,
): boolean {
  for (const [, specifier = ''] of contents.matchAll(RELATIVE_SPECIFIER)) {
    // Destructured with a default rather than guarded: group 1 is mandatory in
    // `RELATIVE_SPECIFIER`, so a match always carries it and an `undefined`
    // check is a branch no input can take — an equivalent mutant by
    // construction. The default is unreachable for the same reason.
    if (resolutionsOf(testFile, specifier).includes(target)) {
      return true;
    }
  }
  return false;
}

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
): string[] {
  const found: string[] = [];
  for (const [testFile, contents] of testFiles) {
    if (isImportingTarget(testFile, contents, target)) {
      found.push(testFile);
    }
  }
  return found.toSorted((left, right) => left.localeCompare(right));
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
 * The corpus is read once, lazily: a manifest whose violations are all in test
 * files, or one with no violations at all, reads nothing. Violations already
 * carrying the key are left alone, and a file with no importer gets no key —
 * an empty array would claim "searched, none exist", which is a different
 * thing from "not computed" and would stop a fixer looking.
 */
export function withCoveringTests(
  violations: readonly Violation[],
  loadCorpus: () => ReadonlyMap<string, string>,
): Violation[] {
  let corpus: ReadonlyMap<string, string> | undefined;
  const byFile = new Map<string, readonly string[]>();
  return violations.map((violation) => {
    if (violation.relatedTests !== undefined || isTestFile(violation.file)) {
      return violation;
    }
    corpus ??= loadCorpus();
    let related = byFile.get(violation.file);
    if (related === undefined) {
      related = coveringTests(violation.file, corpus);
      byFile.set(violation.file, related);
    }
    return related.length === 0
      ? violation
      : { ...violation, relatedTests: related };
  });
}
