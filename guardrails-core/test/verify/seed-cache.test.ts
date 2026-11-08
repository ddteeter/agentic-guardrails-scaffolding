import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnExec, type Exec, type ExecResult } from '../../src/exec.js';
import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import {
  fetchSeed,
  nodeSeedSeams,
  type SeedSeams,
} from '../../src/verify/seed-cache.js';

const SEED_DIR = '/scratch/seed-1';

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
    const fake = fakeSeams({ 'a.json': shard('src/a.ts') });
    await fetchSeed(fake.seams, settings);
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
      'a.json': shard('src/a.ts'),
      [path.join('shard-2', 'b.json')]: shard('src/b.ts'),
    });
    const seed = await fetchSeed(fake.seams, settings);
    expect(new Set(seededFiles(seed))).toEqual(
      new Set(['src/a.ts', 'src/b.ts']),
    );
    expect(fake.warnings).toEqual([
      'guardrails: seeded the mutation cache from 2 report(s) (mutationCache.seedFrom).',
    ]);
    expect(fake.removed).toEqual([SEED_DIR]);
  });

  it('ignores a fingerprint sidecar and anything that is not JSON', async () => {
    const fake = fakeSeams({
      'stryker-incremental.json': shard('src/a.ts'),
      'stryker-incremental.fingerprint.json': '{"strykerVersion":"10.0.0"}',
      'notes.txt': 'not a report',
    });
    const seed = await fetchSeed(fake.seams, settings);
    expect(seededFiles(seed)).toEqual(['src/a.ts']);
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
      const fake = fakeSeams({ 'a.json': shard('src/a.ts') }, result);
      expect(await fetchSeed(fake.seams, settings)).toBeUndefined();
      expect(fake.warnings).toEqual([
        `guardrails: mutation cache seed (mutationCache.seedFrom) ${why}; running stryker cold.`,
      ]);
      expect(fake.removed).toEqual([SEED_DIR]);
    },
  );

  it('runs cold when nothing lands in the seed dir', async () => {
    const fake = fakeSeams({ 'notes.txt': '' });
    expect(await fetchSeed(fake.seams, settings)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) wrote no report to $GUARDRAILS_SEED_DIR; running stryker cold.',
    ]);
  });

  it('runs cold when the reports cannot be merged', async () => {
    const fake = fakeSeams({
      'a.json': shard('src/a.ts'),
      'b.json': shard('src/a.ts'),
    });
    expect(await fetchSeed(fake.seams, settings)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) left reports that cannot be merged (malformed, or one file in two reports); running stryker cold.',
    ]);
  });

  it('runs cold when the seed dir cannot be read', async () => {
    const fake = fakeSeams({});
    fake.seams.listFiles = () => Promise.reject(new Error('EACCES'));
    expect(await fetchSeed(fake.seams, settings)).toBeUndefined();
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) could not be read (EACCES); running stryker cold.',
    ]);
    expect(fake.removed).toEqual([SEED_DIR]);
  });

  it('runs cold when no seed dir can be made, without running the command', async () => {
    const fake = fakeSeams({});
    fake.seams.makeTempDir = () => Promise.reject(new Error('ENOSPC'));
    expect(await fetchSeed(fake.seams, settings)).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(fake.warnings).toEqual([
      'guardrails: mutation cache seed (mutationCache.seedFrom) could not be read (ENOSPC); running stryker cold.',
    ]);
  });

  it('still returns the seed when the seed dir cannot be removed', async () => {
    const fake = fakeSeams({ 'a.json': shard('src/a.ts') });
    fake.seams.removeDirectory = () => Promise.reject(new Error('EBUSY'));
    expect(seededFiles(await fetchSeed(fake.seams, settings))).toEqual([
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
    const seed = await fetchSeed(seams, {
      command:
        'mkdir -p "$GUARDRAILS_SEED_DIR/nested" && cp report.json "$GUARDRAILS_SEED_DIR/nested/"',
      timeoutSeconds: 10,
    });
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
