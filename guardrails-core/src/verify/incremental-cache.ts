/**
 * Stryker's incremental cache (`reports/stryker-incremental.json`), read as a
 * model the gate can REWRITE rather than only keep or delete (#156).
 *
 * The file is a mutation-testing-elements report. Before this, the gate either
 * let stryker reuse all of it or deleted all of it, and since #67 it deleted it
 * whenever a changed test was newer — which is every re-ship of the normal
 * loop (survivors found, tests added, ship again), so every re-ship started
 * cold. The model below lets the caller drop exactly the verdicts it cannot
 * vouch for and hand the rest back to `--incremental`.
 *
 * The rewrite rests on facts about real stryker that
 * `test/drift/stryker-cache-semantics.test.ts` pins: a `killedBy` id resolves
 * to one test under `testFiles[<file>].tests`, the vitest runner records no
 * other way to find a test's file, and a cached static survivor is reused
 * after its killing test lands (stryker-js#6119).
 *
 * Validated at the boundary, field by field, with no casts: this is JSON off
 * disk that a hand-run stryker, an older version, or a half-written file may
 * have produced. Anything outside the shape below rejects the whole file, and
 * the caller takes a cold run. Fields the model does not need are carried in
 * `raw` untouched, because stryker reads the rewritten file back as its own
 * cache and diffs the `source` texts in it.
 */

import { isRecord } from '../is-record.js';
import { parseJsonText } from '../json-file.js';

/**
 * How a changed test invalidates cached verdicts (`mutationCache.invalidation`).
 *
 * - `targeted` (the default): drop only the verdicts a changed test could have
 *   affected — see `dropUntrusted`.
 * - `any-test-change`: discard the whole cache once any test changed since it
 *   was written, which is what the gate did from #67 until #156.
 */
export type CacheInvalidation = 'targeted' | 'any-test-change';

export const CACHE_INVALIDATIONS: readonly CacheInvalidation[] = [
  'targeted',
  'any-test-change',
];

interface CachedMutant {
  readonly status: string;
  /**
  Test ids stryker recorded as failing on this mutant; `[]` when absent.
  */
  readonly killedBy: readonly string[];
  /**
  Test ids stryker recorded as executing this mutant; `[]` when absent.
  */
  readonly coveredBy: readonly string[];
  /**
  The mutant exactly as stryker wrote it.
  */
  readonly raw: Readonly<Record<string, unknown>>;
}

interface CachedFile {
  readonly mutants: readonly CachedMutant[];
  /**
  The file entry as stryker wrote it (`language`, `source`, ...).
  */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface IncrementalCache {
  readonly files: ReadonlyMap<string, CachedFile>;
  /**
  Test id → the test file it sits in. An id two files claim is absent.
  */
  readonly testFileOf: ReadonlyMap<string, string>;
  /**
  The report as stryker wrote it, `files` included.
  */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * An optional list of test ids: absent reads as `[]`, and anything that is
 * present but not an array of strings is `undefined` — a malformed cache.
 */
function testIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.filter((id) => typeof id === 'string');
  return ids.length === value.length ? ids : undefined;
}

function hasStartLine(location: unknown): boolean {
  return (
    isRecord(location) &&
    isRecord(location.start) &&
    typeof location.start.line === 'number'
  );
}

function parseMutant(value: unknown): CachedMutant | undefined {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    typeof value.mutatorName !== 'string' ||
    !hasStartLine(value.location)
  ) {
    return undefined;
  }
  const killedBy = testIds(value.killedBy);
  const coveredBy = testIds(value.coveredBy);
  if (killedBy === undefined || coveredBy === undefined) {
    return undefined;
  }
  return { status: value.status, killedBy, coveredBy, raw: value };
}

/**
 * `parse` applied to every element of `list`, or `undefined` if it is not an
 * array or any one element does not parse — a list is valid whole or not at
 * all.
 */
function parseList<T>(
  list: unknown,
  parse: (element: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const parsed = list.map((element) => parse(element));
  const valid = parsed.filter((element) => element !== undefined);
  return valid.length === parsed.length ? valid : undefined;
}

function parseFile(value: unknown): CachedFile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mutants = parseList(value.mutants, parseMutant);
  return mutants && { mutants, raw: value };
}

function parseFiles(value: unknown): Map<string, CachedFile> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const files = new Map<string, CachedFile>();
  for (const [file, entry] of Object.entries(value)) {
    const parsed = parseFile(entry);
    if (parsed === undefined) {
      return undefined;
    }
    files.set(file, parsed);
  }
  return files;
}

/**
The ids one `testFiles` entry declares, or `undefined` if it is malformed.
*/
function declaredTestIds(entry: unknown): string[] | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  return parseList(entry.tests, (test) =>
    isRecord(test) && typeof test.id === 'string' ? test.id : undefined,
  );
}

/**
 * Test id → test file. `testFiles` is optional in the schema, and a report
 * without it names no tests — every kill in it is then untraceable, which the
 * caller treats as untrusted.
 *
 * An id declared twice — by two files, or twice by one — is left out rather
 * than resolved to either: a kill attributed to it cannot be traced to ONE
 * file, and a rule that asks "did the killing test's file change?" has no
 * answer for it.
 */
function parseTestFiles(value: unknown): Map<string, string> | undefined {
  if (value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const testFileOf = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [file, entry] of Object.entries(value)) {
    const ids = declaredTestIds(entry);
    if (ids === undefined) {
      return undefined;
    }
    for (const id of ids) {
      if (testFileOf.has(id)) {
        ambiguous.add(id);
      }
      testFileOf.set(id, file);
    }
  }
  for (const id of ambiguous) {
    testFileOf.delete(id);
  }
  return testFileOf;
}

/**
 * The cache in `json`, or `undefined` for anything that is not one — including
 * the `''` a missing file reads as.
 */
export function parseIncrementalCache(
  json: string,
): IncrementalCache | undefined {
  const { parsed } = parseJsonText(json);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const files = parseFiles(parsed.files);
  const testFileOf = parseTestFiles(parsed.testFiles);
  if (files === undefined || testFileOf === undefined) {
    return undefined;
  }
  return { files, testFileOf, raw: parsed };
}

/**
 * The cache as stryker should read it: the original report, with `files`
 * replaced by what is left of them. Everything else — `testFiles` with its
 * sources, `schemaVersion`, `thresholds` — is written back as it was read.
 */
export function serializeIncrementalCache(cache: IncrementalCache): string {
  const files = Object.fromEntries(
    [...cache.files].map(([file, entry]) => [
      file,
      { ...entry.raw, mutants: entry.mutants.map((each) => each.raw) },
    ]),
  );
  return JSON.stringify({ ...cache.raw, files });
}

function withFiles(
  cache: IncrementalCache,
  files: ReadonlyMap<string, CachedFile>,
): IncrementalCache {
  return { ...cache, files };
}

/**
 * The cache with only the files this run mutates.
 *
 * Replaces the old all-or-nothing scope rule (critique B). A cached file this
 * run does not mutate still has to go — stryker folds every cached verdict it
 * did not re-run back into the report it writes (drift test 0.3), which is how
 * a negated file once raised violations nobody could fix (#56) — but the
 * in-scope verdicts beside it are still this run's to reuse.
 */
export function filterToScope(
  cache: IncrementalCache,
  mutateFiles: readonly string[],
): IncrementalCache {
  const inScope = new Set(mutateFiles);
  return withFiles(
    cache,
    new Map([...cache.files].filter(([file]) => inScope.has(file))),
  );
}

/**
 * Did the run that wrote this cache record per-test coverage at all?
 *
 * One attributed mutant anywhere is enough: a `NoCoverage` or static mutant
 * legitimately names none. A cache in which NONE does was written by a runner
 * that reports no per-test data, and stryker's differ then reuses a survivor
 * however the tests changed. The caller discards such a cache whole — the
 * other half of the same question, whether THIS run can report coverage, is
 * `canReportPerTestCoverage`.
 */
export function hasPerTestCoverage(cache: IncrementalCache): boolean {
  return cache.files
    .values()
    .some((entry) => entry.mutants.some((each) => each.coveredBy.length > 0));
}

/**
 * Every test file the cache names, once each, in the order first named — the
 * files whose timestamps tell the caller whether the suite moved on since the
 * cache was written.
 */
export function cacheTestFiles(cache: IncrementalCache): string[] {
  return [...new Set(cache.testFileOf.values())];
}

/**
 * The tests that vouch for a kept verdict.
 *
 * A `Killed` mutant names the tests that failed on it. A `Timeout` usually
 * names none — stryker cut the run off rather than seeing a test fail — so
 * its covering tests stand in: they are the only tests that could have hung
 * it, and if none of their files changed they will hang it again.
 */
function vouchingTests(mutant: CachedMutant): readonly string[] {
  if (mutant.status === 'Timeout' && mutant.killedBy.length === 0) {
    return mutant.coveredBy;
  }
  return mutant.killedBy;
}

const KEPT_STATUSES: ReadonlySet<string> = new Set(['Killed', 'Timeout']);

function isTrusted(
  mutant: CachedMutant,
  testFileOf: ReadonlyMap<string, string>,
  changedTestFiles: ReadonlySet<string>,
): boolean {
  if (!KEPT_STATUSES.has(mutant.status)) {
    return false;
  }
  const tests = vouchingTests(mutant);
  return (
    tests.length > 0 &&
    tests.every((id) => {
      const file = testFileOf.get(id);
      return file !== undefined && !changedTestFiles.has(file);
    })
  );
}

/**
 * The cache with every verdict it cannot vouch for removed (#156's targeted
 * rule). Stryker re-tests whatever is missing.
 *
 * - **Survived and NoCoverage always go.** They are what the next test is
 *   written to kill, and stryker reuses a static survivor after that test
 *   lands (stryker-js#6119, drift test 0.2). Re-testing them is the point.
 * - **Killed and Timeout stay only when every test vouching for them sits in a
 *   file not in `changedTestFiles`.** Adding a test cannot revive a killed
 *   mutant, but changing the test that killed it can — and "changed" is
 *   decided by the caller as changed at all, since a test is weakened by an
 *   added line as easily as by a removed one.
 * - **A verdict no test vouches for goes**: a kill whose test id resolves to
 *   no file, or which names no test.
 * - **Every other status goes** — Ignored, CompileError, RuntimeError,
 *   Pending. No rule here vouches for them, and stryker recomputes them
 *   cheaply.
 */
export function dropUntrusted(
  cache: IncrementalCache,
  changedTestFiles: ReadonlySet<string>,
): IncrementalCache {
  const files = new Map(
    [...cache.files].map(([file, entry]) => [
      file,
      {
        ...entry,
        mutants: entry.mutants.filter((each) =>
          isTrusted(each, cache.testFileOf, changedTestFiles),
        ),
      },
    ]),
  );
  return withFiles(cache, files);
}
