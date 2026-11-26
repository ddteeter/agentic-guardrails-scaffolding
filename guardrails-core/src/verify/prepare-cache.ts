/**
 * Readies stryker's incremental cache for the run about to start (#156):
 * read it, check what it was measured under, keep only what this run may
 * reuse, and write that back — or delete it.
 *
 * This replaced `discardUnusableIncrementalCache`, which could only keep the
 * cache whole or delete it whole, and since #67 deleted it whenever a changed
 * test was newer than it — every re-ship of the normal gate loop. The rules
 * the rewrite applies live in `incremental-cache.ts` (what a verdict needs to
 * be kept) and `cache-fingerprint.ts` (what discards everything); this module
 * is the order they run in and the files they read.
 *
 * Deleting stays the fail-closed direction for every uncertainty, and it has
 * to be a real delete rather than "do not pass `--incremental`": a consumer's
 * `stryker.conf.json` may set `incremental: true` itself, and stryker then
 * reads whatever file is there.
 */

import path from 'node:path';

import { upwardFrom } from '../path-walk.js';
import {
  computeFingerprint,
  LOCKFILE_NAMES,
  serializeFingerprint,
  strykerVersionFrom,
  describeDifference,
  isSameFingerprint,
  parseFingerprint,
  whyUnreadFingerprint,
  type CacheFingerprint,
  type DependencyEvidence,
  type Lockfile,
} from './cache-fingerprint.js';
import type { SeedFetch } from './seed-cache.js';
import { isTestFile } from '../packs/typescript-files.js';
import {
  isTestSpecFile,
  isTestSupportFile,
  isWiredToEveryTest,
} from './git.js';
import type { ImportersOf } from './importing-tests.js';
import {
  cacheTestFiles,
  dropUnresolvedKills,
  dropUntrusted,
  filterToScope,
  hasPerTestCoverage,
  parseIncrementalCache,
  serializeIncrementalCache,
  type CacheInvalidation,
  type IncrementalCache,
} from './incremental-cache.js';
import { mergeSeedInto } from './merge-reports.js';
import {
  UNREADABLE_CACHE_TIME,
  UNREADABLE_TEST_TIME,
  haveTestsChangedSinceCache,
} from './stryker-adapter.js';

export const STRYKER_INCREMENTAL_PATH = path.join(
  'reports',
  'stryker-incremental.json',
);

/**
Beside the cache, and gitignored with it (`scaffold/merge.ts`).
*/
const STRYKER_FINGERPRINT_PATH = path.join(
  'reports',
  'stryker-incremental.fingerprint.json',
);

export interface CacheSeams {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  removeFile: (filePath: string) => Promise<void>;
  /**
  Epoch milliseconds.
  */
  fileModifiedTime: (filePath: string) => Promise<number>;
  repoRoot: string;
  /**
   * A seed for the files the local cache lacks, as one report's JSON, or
   * `undefined` for none (#157, `mutationCache.seedFrom` — see
   * `seed-cache.ts`, which checks it was measured under `fingerprint`).
   * Absent when the project configures no seed.
   */
  seed?: ((fingerprint: CacheFingerprint) => Promise<SeedFetch>) | undefined;
  /**
   * The installed versions that can change a verdict (#177,
   * `verdict-dependencies.ts`), or `undefined` when they cannot be read.
   * Absent, or `undefined`, fingerprints the lockfiles instead.
   */
  dependencyPins?: (() => Promise<readonly string[] | undefined>) | undefined;
  /**
   * The tests, of those asked about, that import each changed test-support
   * file (#197, `importing-tests.ts`), or `undefined` when that cannot be
   * told. Absent, a changed support file discards everything, as it did
   * before targeted support invalidation.
   */
  importersOf?: ImportersOf | undefined;
}

export interface CacheRun {
  /**
  The files this run mutates, with the project's `!` exclusions applied.
  */
  mutateFiles: readonly string[];
  /**
  Every file this run's change set holds, tests and support included.
  */
  changedFiles: readonly string[];
  /**
  The stryker config text (`''` when none was read).
  */
  strykerConfig: string;
  /**
  `canReportPerTestCoverage` for the config this run will use.
  */
  canThisRunReportCoverage: boolean;
  invalidation: CacheInvalidation;
}

/**
`filePath`'s text, or `''` when it cannot be read.
*/
export async function readOrEmpty(
  seams: ReadSeams,
  filePath: string,
): Promise<string> {
  try {
    return await seams.readFile(filePath);
  } catch {
    return '';
  }
}

/**
 * The installed `@stryker-mutator/core` version, found the way Node resolves
 * it — `node_modules` in the repo root or any ancestor, so a hoisted
 * workspace install is found too. Sequential on purpose: the nearest install
 * is the one stryker runs.
 */
async function installedStrykerVersion(
  seams: ReadSeams,
): Promise<string | undefined> {
  for (const directory of upwardFrom(seams.repoRoot)) {
    const manifest = await readOrEmpty(
      seams,
      path.join(
        directory,
        'node_modules',
        '@stryker-mutator',
        'core',
        'package.json',
      ),
    );
    if (manifest !== '') {
      return strykerVersionFrom(manifest);
    }
  }
  return undefined;
}

/**
The pinned versions when they can be read, else the lockfiles (#177).
*/
async function dependencyEvidence(
  seams: ReadSeams,
): Promise<DependencyEvidence> {
  const pins = await seams.dependencyPins?.();
  return pins === undefined
    ? { lockfiles: await presentLockfiles(seams) }
    : { pins };
}

async function presentLockfiles(seams: ReadSeams): Promise<Lockfile[]> {
  const read = await Promise.all(
    LOCKFILE_NAMES.map(async (name) => ({
      name,
      contents: await readOrEmpty(seams, path.join(seams.repoRoot, name)),
    })),
  );
  return read.filter(({ contents }) => contents !== '');
}

async function modifiedTime(
  seams: CacheSeams,
  filePath: string,
  unreadable: number,
): Promise<number> {
  try {
    return await seams.fileModifiedTime(filePath);
  } catch {
    return unreadable;
  }
}

/**
 * The test files, of those `files` names, touched since the cache was
 * written — or that can no longer be stat-ed, which a deleted test cannot be.
 * An unreadable cache timestamp makes every one of them newer.
 */
async function testsNewerThanCache(
  seams: CacheSeams,
  files: readonly string[],
): Promise<string[]> {
  const cacheModified = await modifiedTime(
    seams,
    path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    UNREADABLE_CACHE_TIME,
  );
  const stamped = await Promise.all(
    files.map(async (file) => ({
      file,
      modified: await modifiedTime(
        seams,
        path.join(seams.repoRoot, file),
        UNREADABLE_TEST_TIME,
      ),
    })),
  );
  return stamped
    .filter(({ modified }) =>
      haveTestsChangedSinceCache(cacheModified, [modified]),
    )
    .map(({ file }) => file);
}

/**
 * The test files, of those a rule asks about, that changed since the cache
 * was measured.
 */
type NewerThanCache = (files: readonly string[]) => Promise<string[]>;

/**
 * `json` as a cache this run may weigh, cut to its files, or `undefined`.
 *
 * In order: the run must be able to tell a stale verdict (coverage); the
 * cache must parse; and cut to this run's files it must still show per-test
 * coverage. A changed test-support file is the invalidation rule's to judge.
 */
function admissible(json: string, run: CacheRun): IncrementalCache | undefined {
  if (!run.canThisRunReportCoverage) {
    return undefined;
  }
  const cache = parseIncrementalCache(json);
  if (cache === undefined) {
    return undefined;
  }
  const scoped = filterToScope(cache, run.mutateFiles);
  return hasPerTestCoverage(scoped) ? scoped : undefined;
}

/**
 * What a run's changed test-support files cost a cache whose tests are
 * `testFiles`: the tests whose kills they make untrusted, or why they make
 * every kill untrusted.
 */
type SupportImpact = { tests: ReadonlySet<string> } | { why: string };

/**
 * Under `targeted` (#197): a changed support file costs the kills of the
 * tests that import it, directly or through other modules. Everything the
 * graph cannot vouch for discards the whole cache instead — a file wired to
 * every test without an import, a support file no test imports (it reaches
 * them some way the graph cannot see), and a graph that cannot be traced.
 *
 * The tests asked about are the cache's own, plus the spec files this run
 * changed: a helper only a new test imports is not imported by nothing.
 */
async function supportImpact(
  seams: Pick<CacheSeams, 'importersOf'>,
  run: CacheRun,
  testFiles: readonly string[],
): Promise<SupportImpact> {
  const support = run.changedFiles.filter((file) => isTestSupportFile(file));
  if (support.length === 0) {
    return { tests: new Set() };
  }
  const wired = support.find((file) => isWiredToEveryTest(file));
  if (wired !== undefined) {
    return { why: `${wired} changed, and it reaches tests without an import` };
  }
  const { importersOf } = seams;
  if (importersOf === undefined) {
    return {
      why: `${support.join(', ')} changed, and there is no import graph to trace what imports it`,
    };
  }
  const asked = [
    ...new Set([
      ...testFiles,
      ...run.changedFiles.filter((file) => isTestSpecFile(file)),
    ]),
  ];
  const importers = await askImporters(importersOf, support, asked);
  if (importers === undefined) {
    return {
      why: `the tests that import ${support.join(', ')} could not be traced`,
    };
  }
  const unimported = support.find(
    (file) => (importers.get(file)?.size ?? 0) === 0,
  );
  return unimported === undefined
    ? {
        tests: new Set(
          Array.from(importers.values(), (tests) => [...tests]).flat(),
        ),
      }
    : { why: `${unimported} changed, and no test imports it` };
}

/**
The seam's answer, with a seam that throws as no answer.
*/
async function askImporters(
  importersOf: ImportersOf,
  supportFiles: readonly string[],
  testFiles: readonly string[],
): Promise<Awaited<ReturnType<ImportersOf>>> {
  try {
    return await importersOf(supportFiles, testFiles);
  } catch {
    // A graph that fails is a graph that cannot vouch: no answer.
  }
}

/**
A cache the invalidation rule kept, or why it kept none.
*/
type Trust = { cache: IncrementalCache } | { why: string };

const INVALIDATED = 'this change set invalidates it';

/**
The invalidation rule applied to an admissible cache.
*/
async function trusted(
  seams: CacheSeams,
  cache: IncrementalCache,
  run: CacheRun,
  newerThanCache: NewerThanCache,
): Promise<Trust> {
  if (run.invalidation === 'any-test-change') {
    if (run.changedFiles.some((file) => isTestSupportFile(file))) {
      return { why: INVALIDATED };
    }
    const stale = await newerThanCache(
      run.changedFiles.filter((file) => isTestFile(file)),
    );
    return stale.length === 0 ? { cache } : { why: INVALIDATED };
  }
  const impact = await supportImpact(seams, run, cacheTestFiles(cache));
  if ('why' in impact) {
    return impact;
  }
  // The WHOLE change set, not only its `*.test.*` files: `dropUntrusted`
  // looks a changed file up among the files the cache itself names as tests,
  // so a production file is a no-op there and a suite named some other way
  // (`*.check.ts`) is still caught.
  const changedTests = new Set([
    ...run.changedFiles,
    ...impact.tests,
    ...(await newerThanCache(cacheTestFiles(cache))),
  ]);
  return { cache: dropUntrusted(cache, changedTests) };
}

/**
 * What `prepareIncrementalCache` did, for the run log (#176): whether the
 * local cache was kept, absent or discarded, whether a seed was used,
 * refused, not needed, skipped (this run could not use one) or not
 * configured, and why a cache was discarded or a seed refused.
 */
export interface CacheOutcome {
  local: 'kept' | 'none' | 'discarded';
  seed: 'used' | 'refused' | 'not-needed' | 'skipped' | 'off';
  why?: string;
}

interface LocalVerdict {
  cache?: IncrementalCache;
  local: CacheOutcome['local'];
  why?: string;
}

/**
Why a cache's sidecar does not match this checkout, in words.
*/
function staleWhy(
  previous: string,
  current: CacheFingerprint | undefined,
): string {
  const recorded = parseFingerprint(previous);
  if (recorded === undefined) {
    return `its fingerprint ${whyUnreadFingerprint(previous)}`;
  }
  return current === undefined
    ? 'no installed stryker to fingerprint this checkout'
    : `it was measured under ${describeDifference(recorded, current)}`;
}

/**
 * The local cache this run may reuse, and what became of it: written under
 * this run's fingerprint, admissible, and then the invalidation rule, with
 * "changed since" read off the cache file's timestamp.
 */
async function reusableCache(
  seams: CacheSeams,
  run: CacheRun,
  fingerprint: CacheFingerprint | undefined,
  previous: string,
): Promise<LocalVerdict> {
  const text = await readOrEmpty(
    seams,
    path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
  );
  if (text === '') {
    return { local: 'none' };
  }
  if (!isSameFingerprint(previous, fingerprint)) {
    return { local: 'discarded', why: staleWhy(previous, fingerprint) };
  }
  const admitted = admissible(text, run);
  if (admitted === undefined) {
    return { local: 'discarded', why: INVALIDATED };
  }
  const verdict = await trusted(seams, admitted, run, (files) =>
    testsNewerThanCache(seams, files),
  );
  return 'why' in verdict
    ? { local: 'discarded', why: verdict.why }
    : { cache: verdict.cache, local: 'kept' };
}

/**
 * Could a seed be used at all? A run that cannot report per-test coverage
 * would discard one unread, and so would one that changed a test-support
 * file it cannot trace: one wired to every test, one with no import graph to
 * ask, or any under `any-test-change` — which also discards a seed for any
 * changed test. Waiting on a download for it buys nothing.
 */
function canUseSeed(seams: CacheSeams, run: CacheRun): boolean {
  return (
    run.canThisRunReportCoverage &&
    run.changedFiles.every((file) =>
      run.invalidation === 'any-test-change'
        ? !isTestFile(file) && !isTestSupportFile(file)
        : !isTestSupportFile(file) ||
          (!isWiredToEveryTest(file) && seams.importersOf !== undefined),
    )
  );
}

/**
 * The invalidation rule applied to a seed cut to `missing`, judged by this
 * branch's changed files alone. Under `any-test-change` a changed test never
 * gets here (`canUseSeed`), so the seed is kept whole, as a local cache with
 * no newer test is.
 */
async function trustedSeed(
  seams: CacheSeams,
  run: CacheRun,
  admitted: IncrementalCache,
  missing: readonly string[],
): Promise<Trust> {
  const scoped = filterToScope(admitted, missing);
  if (run.invalidation === 'any-test-change') {
    return { cache: scoped };
  }
  const impact = await supportImpact(seams, run, cacheTestFiles(scoped));
  return 'why' in impact
    ? impact
    : {
        cache: dropUntrusted(
          scoped,
          new Set([...run.changedFiles, ...impact.tests]),
        ),
      };
}

/**
 * The cache to write: the local one with a seed's entries added for the
 * in-scope files it lacks (#157), or `undefined` when nothing was seeded.
 *
 * Per file, on every run — a fresh worktree lacks every file, a new branch
 * in an old checkout lacks the files it touches, and a cache just discarded
 * lacks them all. Where both hold a file the local entry is kept. The seed
 * is fetched only when some in-scope file is missing, because the command
 * costs a download. (A file with no mutants never appears in a report, so
 * one in scope keeps asking.)
 *
 * The seed passes the rules a local cache does, with one difference: a
 * seeded kill is judged stale by this branch's changed files alone, since
 * the local cache's timestamp says nothing about when CI measured it. The
 * two are then merged with their test ids re-keyed (`mergeSeedInto`); a
 * seeded kill whose test no longer resolves after that is dropped, and a
 * merge that cannot vouch for itself leaves the local cache alone.
 */
async function withSeed(
  seams: CacheSeams,
  run: CacheRun,
  fingerprint: CacheFingerprint | undefined,
  local: IncrementalCache | undefined,
): Promise<SeedVerdict> {
  const missing = run.mutateFiles.filter((file) => !local?.files.has(file));
  const { seed: fetchSeed } = seams;
  if (fingerprint === undefined || fetchSeed === undefined) {
    return { seed: 'off' };
  }
  if (missing.length === 0) {
    return { seed: 'not-needed' };
  }
  if (!canUseSeed(seams, run)) {
    return { seed: 'skipped' };
  }
  const fetched = await fetchSeed(fingerprint);
  if ('why' in fetched) {
    return { seed: 'refused', why: fetched.why };
  }
  const admitted = admissible(fetched.seed, run);
  if (admitted === undefined) {
    return { seed: 'refused', why: 'it holds no per-test coverage' };
  }
  const seed = await trustedSeed(seams, run, admitted, missing);
  if ('why' in seed) {
    return { seed: 'refused', why: seed.why };
  }
  const seedJson = serializeIncrementalCache(seed.cache);
  if (local === undefined) {
    return { json: seedJson, seed: 'used' };
  }
  const merged = parseIncrementalCache(
    mergeSeedInto(serializeIncrementalCache(local), seedJson) ?? '',
  );
  return merged === undefined
    ? { seed: 'refused', why: 'it could not be merged into the local cache' }
    : {
        json: serializeIncrementalCache(
          dropUnresolvedKills(merged, new Set(missing)),
        ),
        seed: 'used',
      };
}

interface SeedVerdict {
  /**
  The cache to write, when a seed was used.
  */
  json?: string;
  seed: CacheOutcome['seed'];
  why?: string;
}

async function writeOrRemove(
  seams: CacheSeams,
  filePath: string,
  contents: string | undefined,
): Promise<void> {
  if (contents !== undefined) {
    try {
      await seams.writeFile(filePath, contents);
      return;
    } catch {
      // Fall through: a file that could not be rewritten must not survive as
      // it was.
    }
  }
  await seams.removeFile(filePath);
}

type ReadSeams = Pick<CacheSeams, 'readFile' | 'repoRoot' | 'dependencyPins'>;

/**
 * This checkout's fingerprint under `strykerConfig`, or `undefined` when no
 * installed stryker can be found — the value a cache measured here is
 * stamped with.
 */
async function checkoutFingerprint(
  seams: ReadSeams,
  strykerConfig: string,
): Promise<CacheFingerprint | undefined> {
  const [strykerVersion, dependencies] = await Promise.all([
    installedStrykerVersion(seams),
    dependencyEvidence(seams),
  ]);
  return computeFingerprint({
    strykerVersion,
    config: strykerConfig,
    dependencies,
  });
}

/**
 * Write this checkout's fingerprint sidecar, and return its path relative to
 * the repo, or `undefined` (writing nothing) when no installed stryker can be
 * found (#157, `guardrails mutation-fingerprint`).
 *
 * For CI, which runs stryker itself and so never passes through
 * `prepareIncrementalCache`: a seed is used only with this file beside it.
 */
export async function writeFingerprintSidecar(
  seams: ReadSeams & Pick<CacheSeams, 'writeFile'>,
  strykerConfig: string,
): Promise<string | undefined> {
  const fingerprint = await checkoutFingerprint(seams, strykerConfig);
  if (fingerprint === undefined) {
    return undefined;
  }
  await seams.writeFile(
    path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH),
    serializeFingerprint(fingerprint),
  );
  return STRYKER_FINGERPRINT_PATH;
}

export async function prepareIncrementalCache(
  seams: CacheSeams,
  run: CacheRun,
): Promise<CacheOutcome> {
  const [fingerprint, previous] = await Promise.all([
    checkoutFingerprint(seams, run.strykerConfig),
    readOrEmpty(seams, path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH)),
  ]);
  const local = await reusableCache(seams, run, fingerprint, previous);
  const seeded = await withSeed(seams, run, fingerprint, local.cache);
  await writeOrRemove(
    seams,
    path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    seeded.json ?? (local.cache && serializeIncrementalCache(local.cache)),
  );
  // Stamped BEFORE the run, for the cache stryker writes at its end — a cold
  // run included. A sidecar that cannot be written leaves the next run
  // without a match, which is a cold run, not a wrong one.
  await writeOrRemove(
    seams,
    path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH),
    fingerprint && serializeFingerprint(fingerprint),
  );
  const why = [local.why, seeded.why].filter((reason) => reason !== undefined);
  return {
    local: local.local,
    seed: seeded.seed,
    ...(why.length > 0 && { why: why.join('; ') }),
  };
}
