import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnExec, type Exec, type ExecResult } from '../../src/exec.js';
import {
  computeFingerprint,
  serializeFingerprint,
  type CacheFingerprint,
} from '../../src/verify/cache-fingerprint.js';
import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import {
  fetchSeed,
  fetchSeedOutcome,
  nodeSeedSeams,
  type SeedSeams,
} from '../../src/verify/seed-cache.js';

const SEED_DIR = '/scratch/seed-1';

function fingerprintOf(lock: string): CacheFingerprint {
  const fingerprint = computeFingerprint({
    strykerVersion: '10.0.0',
    config: '{}',
    dependencies: {
      lockfiles: [{ name: 'package-lock.json', contents: lock }],
    },
  });
  if (fingerprint === undefined) {
    throw new Error('no fingerprint');
  }
  return fingerprint;
}

/**
This checkout's fingerprint.
*/
const CURRENT = fingerprintOf('{"lockfileVersion":3}');

/**
 * A report at `name` with its fingerprint sidecar beside it, as CI uploads
 * the pair.
 */
function uploaded(
  name: string,
  report: string,
  fingerprint: CacheFingerprint = CURRENT,
): Record<string, string> {
  return {
    [name]: report,
    [name.replace(/\.json$/, '.fingerprint.json')]:
      serializeFingerprint(fingerprint),
  };
}

function shard(file: string): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    files: {
      [file]: {
        source: file,
        mutants: [
          {
            id: '0',
            mutatorName: 'BlockStatement',
            status: 'Killed',
            location: { start: { line: 1, column: 1 } },
            killedBy: ['0'],
            coveredBy: ['0'],
          },
        ],
      },
    },
    testFiles: { 'test/x.test.ts': { tests: [{ id: '0', name: 'x' }] } },
  });
}

interface Call {
  command: string;
  args: string[];
  options: Parameters<Exec>[2];
}

/**
 * Seams over an in-memory seed directory: `landed` is what the command
 * "downloads" into it, keyed by path relative to the directory.
 */
function fakeSeams(
  landed: Record<string, string>,
  result: Partial<ExecResult> = {},
) {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const removed: string[] = [];
  const seams: SeedSeams = {
    repoRoot: '/repo',
    environment: { PATH: '/bin' },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return Promise.resolve({ stdout: '', stderr: '', code: 0, ...result });
    },
    makeTempDir: () => Promise.resolve(SEED_DIR),
    listFiles: () => Promise.resolve(Object.keys(landed)),
    readFile: (filePath) => {
      const text = landed[path.relative(SEED_DIR, filePath)];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${filePath}`))
        : Promise.resolve(text);
    },
    removeDirectory: (directory) => {
      removed.push(directory);
      return Promise.resolve();
    },
    warn: (line) => {
      warnings.push(line);
    },
  };
  return { seams, calls, warnings, removed };
}

const settings = { command: 'fetch-reports', timeoutSeconds: 30 };

/**
The production files a seed holds, or `undefined` for no seed.
*/
function seededFiles(seed: string | undefined): string[] | undefined {
  return seed === undefined
    ? undefined
    : [...(parseIncrementalCache(seed)?.files.keys() ?? [])];
}

describe('fetchSeed', () => {
  it('runs the command through the shell, in the repo, with the seed dir set and a timeout', async () => {
    const fake = fakeSeams(uploaded('a.json', shard('src/a.ts')));
    await fetchSeed(fake.seams, settings, CURRENT);
    expect(fake.calls).toEqual([
      {
        command: 'sh',
        args: ['-c', 'fetch-reports'],
        options: {
          cwd: '/repo',
          env: { PATH: '/bin', GUARDRAILS_SEED_DIR: SEED_DIR },
          processGroup: true,
          timeoutMs: 30_000,
        },
      },
    ]);
  });

  it('merges every report that lands, nested ones included, and says so', async () => {
    const fake = fakeSeams({
      ...uploaded('a.json', shard('src/a.ts')),
      ...uploaded(path.join('shard-2', 'b.json'), shard('src/b.ts')),
    });
    const seed = await fetchSeed(fake.seams, settings, CURRENT);
    expect(new Set(seededFiles(seed))).toEqual(
      new Set(['src/a.ts', 'src/b.ts']),
    );
    expect(fake.warnings).toEqual([
      'guardrails: seeded the mutation cache from 2 report(s) (mutationCache.seedFrom).',
    ]);
    expect(fake.removed).toEqual([SEED_DIR]);
  });

  it('reads the sidecar as a fingerprint, not a report, and ignores anything that is not JSON', async () => {
    const fake = fakeSeams({
      ...uploaded('stryker-incremental.json', shard('src/a.ts')),
      'notes.txt': 'not a report',
    });
    const seed = await fetchSeed(fake.seams, settings, CURRENT);
    expect(seededFiles(seed)).toEqual(['src/a.ts']);
    expect(fake.warnings).toEqual([
      'guardrails: seeded the mutation cache from 1 report(s) (mutationCache.seedFrom).',
    ]);
  });

  describe('checks the seed was measured under this checkout (fingerprint)', () => {
    it.each<[string, Record<string, string>, string]>([
      [
        'a report has no fingerprint beside it',
        {
          ...uploaded('a.json', shard('src/a.ts')),
          [path.join('shard-2', 'b.json')]: shard('src/b.ts'),
        },
        `left ${path.join('shard-2', 'b.json')} with no fingerprint beside it`,
      ],
      [
        'a fingerprint is not JSON',
        { 'a.json': shard('src/a.ts'), 'a.fingerprint.json': 'nope' },
        'left a fingerprint (a.fingerprint.json) that is not valid JSON',
      ],
      [
        'a fingerprint another guardrails-core version wrote (#203)',
        { 'a.json': shard('src/a.ts'), 'a.fingerprint.json': '{"stryker":1}' },
        "left a fingerprint (a.fingerprint.json) that was written by another guardrails-core version; it clears once main's mutation workflow completes a run on this version",
      ],
      [
        'the shards’ fingerprints disagree',
        {
          ...uploaded('a.json', shard('src/a.ts')),
          ...uploaded(
            path.join('shard-2', 'b.json'),
            shard('src/b.ts'),
            fingerprintOf('{"other":true}'),
          ),
        },
        'left shards whose fingerprints disagree',
      ],
      [
        'its dependency versions are not this checkout’s',
        uploaded('a.json', shard('src/a.ts'), fingerprintOf('{"other":true}')),
        'was measured under different dependency versions from this checkout',
      ],
      [
        'its stryker version is not this checkout’s',
        uploaded('a.json', shard('src/a.ts'), {
          ...CURRENT,
          stryker: '10.1.0',
        }),
        'was measured under a different stryker version (10.1.0, here 10.0.0) from this checkout',
      ],
      [
        'its stryker options are not this checkout’s',
        uploaded('a.json', shard('src/a.ts'), { ...CURRENT, options: 'x' }),
        'was measured under different stryker options from this checkout',
      ],
      [
        'all three differ',
        uploaded('a.json', shard('src/a.ts'), {
          stryker: '9.0.0',
          options: 'x',
          dependencies: 'y',
        }),
        'was measured under a different stryker version (9.0.0, here 10.0.0), different stryker options and different dependency versions from this checkout',
      ],
    ])('discards the seed when %s', async (_label, landed, why) => {
      const fake = fakeSeams(landed);
      expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
      expect(fake.warnings).toEqual([
        `guardrails: mutation cache seed (mutationCache.seedFrom) ${why}; running cold for the files it would have covered.`,
      ]);
      expect(fake.removed).toEqual([SEED_DIR]);
    });
  });

  it.each<[string, Partial<ExecResult>, string]>([
    ['exits non-zero', { code: 4 }, 'failed (exit 4)'],
    [
      'cannot be started',
      { code: 1, spawnFailed: true },
      'could not be started',
    ],
    [
      'outlives its timeout',
      { code: 0, signal: 'SIGTERM', timedOut: true },
      'timed out after 30s',
    ],
    [
      'is stopped by a signal',
      { code: 0, signal: 'SIGKILL' },
      'was stopped by SIGKILL',
    ],
  ])(
    'runs cold, saying why, when the command %s',
    async (_label, result, why) => {
      const fake = fakeSeams(uploaded('a.json', shard('src/a.ts')), result);
      expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
      expect(fake.warnings).toEqual([
        `guardrails: mutation cache seed (mutationCache.seedFrom) ${why}; running cold for the files it would have covered.`,
      ]);
      expect(fake.removed).toEqual([SEED_DIR]);
    },
  );

  it('runs cold when nothing lands in the seed dir', async () => {
    const fake = fakeSeams({ 'notes.txt': '' });
    expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) wrote no report to $GUARDRAILS_SEED_DIR; running cold for the files it would have covered.',
    ]);
  });

  it('runs cold when the reports cannot be merged', async () => {
    const fake = fakeSeams({
      ...uploaded('a.json', shard('src/a.ts')),
      ...uploaded('b.json', shard('src/a.ts')),
    });
    expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) left reports that cannot be merged (malformed, or one file in two reports); running cold for the files it would have covered.',
    ]);
  });

  it('runs cold when the seed dir cannot be read', async () => {
    const fake = fakeSeams({});
    fake.seams.listFiles = () => Promise.reject(new Error('EACCES'));
    expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) could not be read (EACCES); running cold for the files it would have covered.',
    ]);
    expect(fake.removed).toEqual([SEED_DIR]);
  });

  it('runs cold when no seed dir can be made, without running the command', async () => {
    const fake = fakeSeams({});
    fake.seams.makeTempDir = () => Promise.reject(new Error('ENOSPC'));
    expect(await fetchSeed(fake.seams, settings, CURRENT)).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) could not be read (ENOSPC); running cold for the files it would have covered.',
    ]);
  });

  it('still returns the seed when the seed dir cannot be removed', async () => {
    const fake = fakeSeams(uploaded('a.json', shard('src/a.ts')));
    fake.seams.removeDirectory = () => Promise.reject(new Error('EBUSY'));
    expect(seededFiles(await fetchSeed(fake.seams, settings, CURRENT))).toEqual(
      ['src/a.ts'],
    );
  });
});

describe('fetchSeedOutcome', () => {
  it('answers why there is no seed, as the warning words it', async () => {
    const fake = fakeSeams(uploaded('a.json', shard('src/a.ts')), { code: 4 });
    expect(await fetchSeedOutcome(fake.seams, settings, CURRENT)).toEqual({
      why: 'failed (exit 4)',
    });
  });

  it('answers the seed when there is one', async () => {
    const fake = fakeSeams(uploaded('a.json', shard('src/a.ts')));
    const outcome = await fetchSeedOutcome(fake.seams, settings, CURRENT);
    expect(seededFiles('seed' in outcome ? outcome.seed : undefined)).toEqual([
      'src/a.ts',
    ]);
  });
});

describe('nodeSeedSeams, against a real shell and filesystem', () => {
  let source: string;

  beforeEach(() => {
    source = mkdtempSync(path.join(tmpdir(), 'guardrails-seed-source-'));
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
  });

  it('fetches what the command copies into GUARDRAILS_SEED_DIR, then removes the dir', async () => {
    writeFileSync(path.join(source, 'report.json'), shard('src/a.ts'));
    writeFileSync(
      path.join(source, 'report.fingerprint.json'),
      serializeFingerprint(CURRENT),
    );
    const warnings: string[] = [];
    let seedDirectory = '';
    const seams = nodeSeedSeams({
      exec: async (command, args, options) => {
        seedDirectory = options?.env?.GUARDRAILS_SEED_DIR ?? '';
        return spawnExec(command, args, options);
      },
      repoRoot: source,
      warn: (line) => {
        warnings.push(line);
      },
    });
    const seed = await fetchSeed(
      seams,
      {
        command:
          'mkdir -p "$GUARDRAILS_SEED_DIR/nested" && cp report.json report.fingerprint.json "$GUARDRAILS_SEED_DIR/nested/"',
        timeoutSeconds: 10,
      },
      CURRENT,
    );
    expect(seededFiles(seed)).toEqual(['src/a.ts']);
    expect(seedDirectory.startsWith(tmpdir())).toBe(true);
    expect(existsSync(seedDirectory)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('passes the inherited environment on to the command', () => {
    const seams = nodeSeedSeams({
      exec: spawnExec,
      repoRoot: source,
      warn: (line) => {
        throw new Error(line);
      },
    });
    expect(seams.environment).toBe(process.env);
  });
});
