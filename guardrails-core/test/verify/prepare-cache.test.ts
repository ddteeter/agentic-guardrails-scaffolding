import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeFingerprint,
  serializeFingerprint,
} from '../../src/verify/cache-fingerprint.js';
import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import {
  prepareIncrementalCache,
  type CacheRun,
} from '../../src/verify/prepare-cache.js';

const ROOT = '/repo';
const CACHE = path.join(ROOT, 'reports', 'stryker-incremental.json');
const SIDECAR = path.join(
  ROOT,
  'reports',
  'stryker-incremental.fingerprint.json',
);
const STRYKER_MANIFEST = path.join(
  ROOT,
  'node_modules',
  '@stryker-mutator',
  'core',
  'package.json',
);
const CONFIG = '{"testRunner":"vitest"}';
const LOCK = '{"lockfileVersion":3}';

function missing(file: string): Error {
  return new Error(`ENOENT: ${file}`);
}

interface Entry {
  contents: string;
  mtime: number;
}

/**
An in-memory filesystem behind the four seams, recording every write.
*/
function memoryFs(initial: Record<string, string | Entry>) {
  const files = new Map<string, Entry>(
    Object.entries(initial).map(([file, value]) => [
      file,
      typeof value === 'string' ? { contents: value, mtime: 1000 } : value,
    ]),
  );
  const stats: string[] = [];
  return {
    files,
    stats,
    seams: {
      repoRoot: ROOT,
      readFile: (file: string) => {
        const entry = files.get(file);
        return entry === undefined
          ? Promise.reject(missing(file))
          : Promise.resolve(entry.contents);
      },
      writeFile: (file: string, contents: string) => {
        files.set(file, { contents, mtime: 9999 });
        return Promise.resolve();
      },
      removeFile: (file: string) => {
        files.delete(file);
        return Promise.resolve();
      },
      fileModifiedTime: (file: string) => {
        stats.push(file);
        const entry = files.get(file);
        return entry === undefined
          ? Promise.reject(missing(file))
          : Promise.resolve(entry.mtime);
      },
    },
  };
}

function sidecar(config = CONFIG, version = '10.0.0', lock = LOCK): string {
  const fingerprint = computeFingerprint({
    strykerVersion: version,
    config,
    lockfiles: [{ name: 'package-lock.json', contents: lock }],
  });
  if (fingerprint === undefined) {
    throw new Error('no fingerprint');
  }
  return serializeFingerprint(fingerprint);
}

function mutant(status: string, killedBy: string[], line = 1): unknown {
  return {
    id: String(line),
    mutatorName: 'ConditionalExpression',
    status,
    location: { start: { line, column: 1 }, end: { line, column: 5 } },
    killedBy,
    coveredBy: killedBy.length > 0 ? killedBy : ['0'],
  };
}

/** A cache over `src/a.ts` (killed by a.test.ts, plus one survivor) and
 *  `src/b.ts` (killed by b.test.ts). */
function cacheJson(): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    files: {
      'src/a.ts': {
        language: 'typescript',
        source: 'a',
        mutants: [mutant('Killed', ['0']), mutant('Survived', [], 2)],
      },
      'src/b.ts': {
        language: 'typescript',
        source: 'b',
        mutants: [mutant('Killed', ['1'])],
      },
    },
    testFiles: {
      'a.test.ts': { tests: [{ id: '0', name: 'a' }] },
      'b.test.ts': { tests: [{ id: '1', name: 'b' }] },
    },
  });
}

/**
A repo whose cache, sidecar and inputs all agree; tests older than it.
*/
function healthyRepo(overrides: Record<string, string | Entry> = {}) {
  return memoryFs({
    [CACHE]: { contents: cacheJson(), mtime: 5000 },
    [SIDECAR]: sidecar(),
    [STRYKER_MANIFEST]: '{"version":"10.0.0"}',
    [path.join(ROOT, 'package-lock.json')]: LOCK,
    [path.join(ROOT, 'a.test.ts')]: { contents: '', mtime: 1000 },
    [path.join(ROOT, 'b.test.ts')]: { contents: '', mtime: 1000 },
    ...overrides,
  });
}

const run: CacheRun = {
  mutateFiles: ['src/a.ts', 'src/b.ts'],
  changedFiles: ['src/a.ts', 'src/b.ts'],
  strykerConfig: CONFIG,
  canThisRunReportCoverage: true,
  invalidation: 'targeted',
};

/**
What is left in the cache file, as `file → statuses`, or `undefined`.
*/
function kept(files: Map<string, Entry>): Record<string, string[]> | undefined {
  const entry = files.get(CACHE);
  const cache = entry && parseIncrementalCache(entry.contents);
  if (cache === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    [...cache.files].map(([file, { mutants }]) => [
      file,
      mutants.map((each) => each.status),
    ]),
  );
}

/**
A fresh worktree: no cache, no sidecar, and a seed on offer.
*/
function freshWorktree(seedJson: string | undefined) {
  const fs = healthyRepo();
  fs.files.delete(CACHE);
  fs.files.delete(SIDECAR);
  let seedCalls = 0;
  const seams = {
    ...fs.seams,
    seed: () => {
      seedCalls += 1;
      return Promise.resolve(seedJson);
    },
  };
  return { ...fs, seams, seedCalls: () => seedCalls };
}

describe('prepareIncrementalCache', () => {
  it('keeps every kill and drops every survivor when no test changed', async () => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, run);
    expect(kept(files)).toEqual({
      'src/a.ts': ['Killed'],
      'src/b.ts': ['Killed'],
    });
  });

  it('drops only the kills whose test file this branch changed (#156)', async () => {
    // The re-ship loop: tests added to a.test.ts to kill the survivor. Its
    // kills go back to stryker; b.test.ts's are reused.
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, {
      ...run,
      changedFiles: [...run.changedFiles, 'a.test.ts'],
    });
    expect(kept(files)).toEqual({ 'src/a.ts': [], 'src/b.ts': ['Killed'] });
  });

  it('treats any changed file the cache names as a test file as changed', async () => {
    // A suite whose files do not follow `*.test.*` naming (a vitest `include`
    // of `*.check.ts`): the cache's own `testFiles` is what says it is a test.
    const { files, seams } = healthyRepo({
      [CACHE]: {
        contents: cacheJson().replaceAll('b.test.ts', 'b.check.ts'),
        mtime: 5000,
      },
      [path.join(ROOT, 'b.check.ts')]: { contents: '', mtime: 1000 },
    });
    await prepareIncrementalCache(seams, {
      ...run,
      changedFiles: [...run.changedFiles, 'b.check.ts'],
    });
    expect(kept(files)).toEqual({ 'src/a.ts': ['Killed'], 'src/b.ts': [] });
  });

  it('treats a cached test file edited after the cache as changed', async () => {
    // Outside this run's changed set — an unstaged edit under commit scope —
    // but newer than the cache, so the cache was not measured against it.
    const { files, seams } = healthyRepo({
      [path.join(ROOT, 'b.test.ts')]: { contents: '', mtime: 5000 },
    });
    await prepareIncrementalCache(seams, run);
    expect(kept(files)).toEqual({ 'src/a.ts': ['Killed'], 'src/b.ts': [] });
  });

  it('treats a cached test file that no longer exists as changed', async () => {
    const { files, seams } = healthyRepo();
    files.delete(path.join(ROOT, 'b.test.ts'));
    await prepareIncrementalCache(seams, run);
    expect(kept(files)).toEqual({ 'src/a.ts': ['Killed'], 'src/b.ts': [] });
  });

  it('treats every cached test as changed when the cache cannot be stat-ed', async () => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(
      {
        ...seams,
        fileModifiedTime: (file) =>
          file === CACHE
            ? Promise.reject(new Error('EACCES'))
            : seams.fileModifiedTime(file),
      },
      run,
    );
    expect(kept(files)).toEqual({ 'src/a.ts': [], 'src/b.ts': [] });
  });

  it('stats each cached test file against the repo root', async () => {
    const { stats, seams } = healthyRepo();
    await prepareIncrementalCache(seams, run);
    expect(stats.toSorted((a, b) => a.localeCompare(b))).toEqual([
      path.join(ROOT, 'a.test.ts'),
      path.join(ROOT, 'b.test.ts'),
      CACHE,
    ]);
  });

  it('drops the files this run does not mutate and keeps the rest', async () => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, { ...run, mutateFiles: ['src/a.ts'] });
    expect(kept(files)).toEqual({ 'src/a.ts': ['Killed'] });
  });

  it.each([
    ['a test helper', 'test/helpers.ts'],
    ['a setup file', 'vitest.setup.ts'],
    ['a snapshot', 'src/__snapshots__/a.test.ts.snap'],
  ])('discards the whole cache when %s changed', async (_label, file) => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, {
      ...run,
      changedFiles: [...run.changedFiles, file],
    });
    expect(files.has(CACHE)).toBe(false);
  });

  it.each([
    [
      'the stryker config',
      { strykerConfig: '{"testRunner":"vitest","mutate":[]}' },
    ],
  ])('discards the whole cache when %s changed', async (_label, overrides) => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, { ...run, ...overrides });
    expect(files.has(CACHE)).toBe(false);
  });

  it.each([
    ['the stryker version', { [STRYKER_MANIFEST]: '{"version":"10.1.1"}' }],
    ['the lockfile', { [path.join(ROOT, 'package-lock.json')]: '{}' }],
    ['the sidecar is malformed', { [SIDECAR]: 'nope' }],
    ['the stryker version is unreadable', { [STRYKER_MANIFEST]: '{}' }],
  ])('discards the whole cache when %s changes', async (_label, overrides) => {
    const { files, seams } = healthyRepo(overrides);
    await prepareIncrementalCache(seams, run);
    expect(files.has(CACHE)).toBe(false);
  });

  it('discards the whole cache when its sidecar is missing', async () => {
    const { files, seams } = healthyRepo();
    files.delete(SIDECAR);
    await prepareIncrementalCache(seams, run);
    expect(files.has(CACHE)).toBe(false);
  });

  it('finds stryker installed in a parent directory, as a workspace hoists it', async () => {
    const { files, seams } = healthyRepo();
    files.delete(STRYKER_MANIFEST);
    files.set(
      path.join(
        '/',
        'node_modules',
        '@stryker-mutator',
        'core',
        'package.json',
      ),
      { contents: '{"version":"10.0.0"}', mtime: 0 },
    );
    await prepareIncrementalCache(seams, run);
    expect(kept(files)).toEqual({
      'src/a.ts': ['Killed'],
      'src/b.ts': ['Killed'],
    });
  });

  it('writes the fingerprint of this run beside the cache', async () => {
    // A cold run writes no sidecar of its own, so without this the NEXT run
    // would find none and discard the cache this one is about to write.
    const { files, seams } = healthyRepo();
    files.delete(SIDECAR);
    await prepareIncrementalCache(seams, run);
    expect(files.get(SIDECAR)?.contents).toBe(sidecar());
  });

  it('removes the sidecar when this run has no fingerprint', async () => {
    const { files, seams } = healthyRepo({ [STRYKER_MANIFEST]: '{}' });
    await prepareIncrementalCache(seams, run);
    expect(files.has(SIDECAR)).toBe(false);
  });

  it('deletes the cache when this run cannot report per-test coverage', async () => {
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(seams, {
      ...run,
      canThisRunReportCoverage: false,
    });
    expect(files.has(CACHE)).toBe(false);
  });

  it('deletes a cache that recorded no per-test coverage in this run’s files', async () => {
    const { files, seams } = healthyRepo({
      [CACHE]: JSON.stringify({
        files: {
          'src/a.ts': {
            mutants: [
              {
                mutatorName: 'BlockStatement',
                status: 'Survived',
                location: { start: { line: 1, column: 1 } },
              },
            ],
          },
        },
      }),
    });
    await prepareIncrementalCache(seams, run);
    expect(files.has(CACHE)).toBe(false);
  });

  it('deletes a cache that does not parse', async () => {
    const { files, seams } = healthyRepo({ [CACHE]: '{"files":"nope"}' });
    await prepareIncrementalCache(seams, run);
    expect(files.has(CACHE)).toBe(false);
  });

  it('writes no cache when there is none to read', async () => {
    const { files, seams } = healthyRepo();
    files.delete(CACHE);
    await prepareIncrementalCache(seams, run);
    expect(files.has(CACHE)).toBe(false);
    // ...but still stamps the fingerprint for the cache the run will write.
    expect(files.has(SIDECAR)).toBe(true);
  });

  it('deletes the cache when the rewrite cannot be written', async () => {
    // Left in place, the UNFILTERED cache would be reused whole.
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(
      {
        ...seams,
        writeFile: (file, contents) =>
          file === CACHE
            ? Promise.reject(new Error('ENOSPC'))
            : seams.writeFile(file, contents),
      },
      run,
    );
    expect(files.has(CACHE)).toBe(false);
  });

  it('survives a sidecar that cannot be written', async () => {
    // The next run then finds no matching sidecar and goes cold — safe.
    const { files, seams } = healthyRepo();
    await prepareIncrementalCache(
      {
        ...seams,
        writeFile: (file, contents) =>
          file === SIDECAR
            ? Promise.reject(new Error('ENOSPC'))
            : seams.writeFile(file, contents),
      },
      run,
    );
    expect(kept(files)).toEqual({
      'src/a.ts': ['Killed'],
      'src/b.ts': ['Killed'],
    });
  });

  describe('under invalidation: any-test-change', () => {
    const anyChange: CacheRun = { ...run, invalidation: 'any-test-change' };

    it('discards the whole cache once a changed test is newer than it', async () => {
      const { files, seams } = healthyRepo({
        [path.join(ROOT, 'a.test.ts')]: { contents: '', mtime: 6000 },
      });
      await prepareIncrementalCache(seams, {
        ...anyChange,
        changedFiles: [...run.changedFiles, 'a.test.ts'],
      });
      expect(files.has(CACHE)).toBe(false);
    });

    it('keeps the whole cache, survivors included, while no test changed', async () => {
      // The behaviour before #156, kept as-is for a consumer who opts into it.
      const { files, seams } = healthyRepo();
      await prepareIncrementalCache(seams, {
        ...anyChange,
        changedFiles: [...run.changedFiles, 'a.test.ts'],
      });
      expect(kept(files)).toEqual({
        'src/a.ts': ['Killed', 'Survived'],
        'src/b.ts': ['Killed'],
      });
    });

    it('still drops the files this run does not mutate', async () => {
      const { files, seams } = healthyRepo();
      await prepareIncrementalCache(seams, {
        ...anyChange,
        mutateFiles: ['src/b.ts'],
      });
      expect(kept(files)).toEqual({ 'src/b.ts': ['Killed'] });
    });

    it('still discards the cache when a setup file changed', async () => {
      const { files, seams } = healthyRepo();
      await prepareIncrementalCache(seams, {
        ...anyChange,
        changedFiles: [...run.changedFiles, 'vitest.setup.ts'],
      });
      expect(files.has(CACHE)).toBe(false);
    });
  });

  describe('seeding a missing cache (#157)', () => {
    it('writes the seed as the cache, and rewrites it like a local one', async () => {
      // Survivors dropped: the seed passes the same targeted rule.
      const { files, seams } = freshWorktree(cacheJson());
      await prepareIncrementalCache(seams, run);
      expect(kept(files)).toEqual({
        'src/a.ts': ['Killed'],
        'src/b.ts': ['Killed'],
      });
    });

    it('stamps the seed with this checkout’s fingerprint', async () => {
      // So the NEXT run reads it as its own local cache.
      const { files, seams } = freshWorktree(cacheJson());
      await prepareIncrementalCache(seams, run);
      expect(files.get(SIDECAR)?.contents).toBe(sidecar());
    });

    it('reuses a seed whatever sidecar was lying around', async () => {
      const { files, seams } = freshWorktree(cacheJson());
      files.set(SIDECAR, { contents: sidecar('{"other":true}'), mtime: 0 });
      await prepareIncrementalCache(seams, run);
      expect(kept(files)).toEqual({
        'src/a.ts': ['Killed'],
        'src/b.ts': ['Killed'],
      });
    });

    it('drops a seeded kill whose test this branch changed', async () => {
      const { files, seams } = freshWorktree(cacheJson());
      await prepareIncrementalCache(seams, {
        ...run,
        changedFiles: [...run.changedFiles, 'a.test.ts'],
      });
      expect(kept(files)).toEqual({ 'src/a.ts': [], 'src/b.ts': ['Killed'] });
    });

    it('cuts a seed to this run’s files', async () => {
      const { files, seams } = freshWorktree(cacheJson());
      await prepareIncrementalCache(seams, {
        ...run,
        mutateFiles: ['src/a.ts'],
      });
      expect(kept(files)).toEqual({ 'src/a.ts': ['Killed'] });
    });

    it('runs cold when no seed came back', async () => {
      const { files, seams } = freshWorktree(undefined);
      await prepareIncrementalCache(seams, run);
      expect(files.has(CACHE)).toBe(false);
      expect(files.get(SIDECAR)?.contents).toBe(sidecar());
    });

    it('runs cold when the seed cannot be written', async () => {
      const { files, seams } = freshWorktree(cacheJson());
      await prepareIncrementalCache(
        {
          ...seams,
          writeFile: (file, contents) =>
            file === CACHE
              ? Promise.reject(new Error('ENOSPC'))
              : seams.writeFile(file, contents),
        },
        run,
      );
      expect(files.has(CACHE)).toBe(false);
    });

    it('does not fetch a seed while a local cache exists', async () => {
      const { files, seams, seedCalls } = freshWorktree(cacheJson());
      files.set(CACHE, { contents: cacheJson(), mtime: 5000 });
      await prepareIncrementalCache(seams, run);
      expect(seedCalls()).toBe(0);
    });

    it('fetches a seed in place of an empty cache file', async () => {
      const { files, seams, seedCalls } = freshWorktree(cacheJson());
      files.set(CACHE, { contents: '', mtime: 5000 });
      await prepareIncrementalCache(seams, run);
      expect(seedCalls()).toBe(1);
    });

    it('does not fetch a seed this run could not use', async () => {
      // No coverage, or no fingerprint to stamp it with: the seed would be
      // discarded unread, so the download is not worth waiting on.
      const noCoverage = freshWorktree(cacheJson());
      await prepareIncrementalCache(noCoverage.seams, {
        ...run,
        canThisRunReportCoverage: false,
      });
      const noStryker = freshWorktree(cacheJson());
      noStryker.files.delete(STRYKER_MANIFEST);
      await prepareIncrementalCache(noStryker.seams, run);
      expect([noCoverage.seedCalls(), noStryker.seedCalls()]).toEqual([0, 0]);
      expect(noStryker.files.has(CACHE)).toBe(false);
    });
  });
});
