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
  isSameFingerprint,
  type CacheFingerprint,
  type Lockfile,
} from './cache-fingerprint.js';
import { isTestFile, isTestSupportFile } from './git.js';
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

const STRYKER_INCREMENTAL_PATH = path.join(
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
  seed?:
    | ((fingerprint: CacheFingerprint) => Promise<string | undefined>)
    | undefined;
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

async function readOrEmpty(
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
 * cache must parse; cut to this run's files it must still show per-test
 * coverage; and a changed test-support file discards it.
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
  return !hasPerTestCoverage(scoped) ||
    run.changedFiles.some((file) => isTestSupportFile(file))
    ? undefined
    : scoped;
}

/**
The invalidation rule applied to an admissible cache.
*/
async function trusted(
  cache: IncrementalCache,
  run: CacheRun,
  newerThanCache: NewerThanCache,
): Promise<IncrementalCache | undefined> {
  if (run.invalidation === 'any-test-change') {
    const stale = await newerThanCache(
      run.changedFiles.filter((file) => isTestFile(file)),
    );
    return stale.length === 0 ? cache : undefined;
  }
  // The WHOLE change set, not only its `*.test.*` files: `dropUntrusted`
  // looks a changed file up among the files the cache itself names as tests,
  // so a production file is a no-op there and a suite named some other way
  // (`*.check.ts`) is still caught.
  const changedTests = new Set([
    ...run.changedFiles,
    ...(await newerThanCache(cacheTestFiles(cache))),
  ]);
  return dropUntrusted(cache, changedTests);
}

/**
 * The local cache this run may reuse, or `undefined` for none: written under
 * this run's fingerprint, admissible, and then the invalidation rule, with
 * "changed since" read off the cache file's timestamp.
 */
async function reusableCache(
  seams: CacheSeams,
  run: CacheRun,
  isFingerprintCurrent: boolean,
): Promise<IncrementalCache | undefined> {
  if (!isFingerprintCurrent) {
    return undefined;
  }
  const cache = admissible(
    await readOrEmpty(
      seams,
      path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    ),
    run,
  );
  return (
    cache && trusted(cache, run, (files) => testsNewerThanCache(seams, files))
  );
}

/**
 * Could a seed be used at all? A run that cannot report per-test coverage,
 * changed a test-support file, or (under `any-test-change`) changed any test
 * would discard one unread, so waiting on a download for it buys nothing.
 */
function canUseSeed(run: CacheRun): boolean {
  return (
    run.canThisRunReportCoverage &&
    run.changedFiles.every(
      (file) =>
        !isTestSupportFile(file) &&
        !(run.invalidation === 'any-test-change' && isTestFile(file)),
    )
  );
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
): Promise<string | undefined> {
  const missing = run.mutateFiles.filter((file) => !local?.files.has(file));
  const { seed: fetchSeed } = seams;
  if (
    fingerprint === undefined ||
    fetchSeed === undefined ||
    missing.length === 0 ||
    !canUseSeed(run)
  ) {
    return undefined;
  }
  const admitted = admissible((await fetchSeed(fingerprint)) ?? '', run);
  if (admitted === undefined) {
    return undefined;
  }
  // The invalidation rule, judged by this branch's changed files alone.
  // Under `any-test-change` a changed test never gets here (`canUseSeed`),
  // so the seed is kept whole, as a local cache with no newer test is.
  const scoped = filterToScope(admitted, missing);
  const seed =
    run.invalidation === 'any-test-change'
      ? scoped
      : dropUntrusted(scoped, new Set(run.changedFiles));
  const seedJson = serializeIncrementalCache(seed);
  if (local === undefined) {
    return seedJson;
  }
  const merged = parseIncrementalCache(
    mergeSeedInto(serializeIncrementalCache(local), seedJson) ?? '',
  );
  return (
    merged &&
    serializeIncrementalCache(dropUnresolvedKills(merged, new Set(missing)))
  );
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

type ReadSeams = Pick<CacheSeams, 'readFile' | 'repoRoot'>;

/**
 * This checkout's fingerprint under `strykerConfig`, or `undefined` when no
 * installed stryker can be found — the value a cache measured here is
 * stamped with.
 */
async function checkoutFingerprint(
  seams: ReadSeams,
  strykerConfig: string,
): Promise<CacheFingerprint | undefined> {
  const [strykerVersion, lockfiles] = await Promise.all([
    installedStrykerVersion(seams),
    presentLockfiles(seams),
  ]);
  return computeFingerprint({
    strykerVersion,
    config: strykerConfig,
    lockfiles,
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
): Promise<void> {
  const [fingerprint, previous] = await Promise.all([
    checkoutFingerprint(seams, run.strykerConfig),
    readOrEmpty(seams, path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH)),
  ]);
  const local = await reusableCache(
    seams,
    run,
    isSameFingerprint(previous, fingerprint),
  );
  const seeded = await withSeed(seams, run, fingerprint, local);
  await writeOrRemove(
    seams,
    path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    seeded ?? (local && serializeIncrementalCache(local)),
  );
  // Stamped BEFORE the run, for the cache stryker writes at its end — a cold
  // run included. A sidecar that cannot be written leaves the next run
  // without a match, which is a cold run, not a wrong one.
  await writeOrRemove(
    seams,
    path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH),
    fingerprint && serializeFingerprint(fingerprint),
  );
}
