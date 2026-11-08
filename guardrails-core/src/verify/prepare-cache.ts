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
  type Lockfile,
} from './cache-fingerprint.js';
import { isTestFile, isTestSupportFile } from './git.js';
import {
  cacheTestFiles,
  dropUntrusted,
  filterToScope,
  hasPerTestCoverage,
  parseIncrementalCache,
  serializeIncrementalCache,
  type CacheInvalidation,
  type IncrementalCache,
} from './incremental-cache.js';
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
  seams: CacheSeams,
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
  seams: CacheSeams,
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

async function presentLockfiles(seams: CacheSeams): Promise<Lockfile[]> {
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
 * The cache this run may reuse, or `undefined` for none.
 *
 * In order: the run must be able to tell a stale verdict (coverage); the cache
 * must parse and have been written under this run's fingerprint; it is cut to
 * this run's files and must still show per-test coverage; a changed
 * test-support file discards it; and then the invalidation rule decides.
 */
async function reusableCache(
  seams: CacheSeams,
  run: CacheRun,
  isFingerprintCurrent: boolean,
): Promise<IncrementalCache | undefined> {
  if (!isFingerprintCurrent || !run.canThisRunReportCoverage) {
    return undefined;
  }
  const cache = parseIncrementalCache(
    await readOrEmpty(
      seams,
      path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    ),
  );
  if (cache === undefined) {
    return undefined;
  }
  const scoped = filterToScope(cache, run.mutateFiles);
  if (
    !hasPerTestCoverage(scoped) ||
    run.changedFiles.some((file) => isTestSupportFile(file))
  ) {
    return undefined;
  }
  if (run.invalidation === 'any-test-change') {
    const stale = await testsNewerThanCache(
      seams,
      run.changedFiles.filter((file) => isTestFile(file)),
    );
    return stale.length === 0 ? scoped : undefined;
  }
  // The WHOLE change set, not only its `*.test.*` files: `dropUntrusted`
  // looks a changed file up among the files the cache itself names as tests,
  // so a production file is a no-op there and a suite named some other way
  // (`*.check.ts`) is still caught.
  const changedTests = new Set([
    ...run.changedFiles,
    ...(await testsNewerThanCache(seams, cacheTestFiles(scoped))),
  ]);
  return dropUntrusted(scoped, changedTests);
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

export async function prepareIncrementalCache(
  seams: CacheSeams,
  run: CacheRun,
): Promise<void> {
  const [strykerVersion, lockfiles, previous] = await Promise.all([
    installedStrykerVersion(seams),
    presentLockfiles(seams),
    readOrEmpty(seams, path.join(seams.repoRoot, STRYKER_FINGERPRINT_PATH)),
  ]);
  const fingerprint = computeFingerprint({
    strykerVersion,
    config: run.strykerConfig,
    lockfiles,
  });
  const cache = await reusableCache(
    seams,
    run,
    isSameFingerprint(previous, fingerprint),
  );
  await writeOrRemove(
    seams,
    path.join(seams.repoRoot, STRYKER_INCREMENTAL_PATH),
    cache && serializeIncrementalCache(cache),
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
