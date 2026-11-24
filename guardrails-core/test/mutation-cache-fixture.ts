/**
 * A repo whose stryker cache tells `targeted` and `any-test-change` apart, for
 * the tests that pin `mutationCache.invalidation`'s wiring.
 *
 * The cache holds one kill by `test/foo.test.ts`, a test the branch changed
 * but BEFORE the cache was written. `targeted` drops that kill (the test
 * changed at all); `any-test-change` keeps it (nothing is newer than the
 * cache). Its sidecar and installed stryker match, so nothing else discards
 * it. Stryker itself is faked by the callers, so the cache on disk afterwards
 * is exactly what the gate prepared.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Exec } from '../src/exec.js';
import {
  computeFingerprint,
  serializeFingerprint,
} from '../src/verify/cache-fingerprint.js';
import { parseIncrementalCache } from '../src/verify/incremental-cache.js';

/**
What the fixture's change set holds, as `git diff --name-only` prints it.
*/
export const CHANGED_FILES = 'src/foo.ts\ntest/foo.test.ts\n';

export const STRYKER_CONFIG = JSON.stringify({ testRunner: 'vitest' });

/**
The fixture checkout's fingerprint sidecar, as `cache-fingerprint.ts` writes it.
*/
function fixtureSidecar(): string {
  const fingerprint = computeFingerprint({
    strykerVersion: '10.0.0',
    config: STRYKER_CONFIG,
    dependencies: { lockfiles: [] },
  });
  return fingerprint === undefined ? '' : serializeFingerprint(fingerprint);
}

export function writeCacheFixture(root: string): void {
  const at = (...parts: string[]) => path.join(root, ...parts);
  const config = STRYKER_CONFIG;
  mkdirSync(at('reports'), { recursive: true });
  mkdirSync(at('test'), { recursive: true });
  mkdirSync(at('node_modules', '@stryker-mutator', 'core'), {
    recursive: true,
  });
  writeFileSync(at('stryker.conf.json'), config);
  writeFileSync(
    at('node_modules', '@stryker-mutator', 'core', 'package.json'),
    '{"version":"10.0.0"}',
  );
  writeFileSync(
    at('reports', 'stryker-incremental.fingerprint.json'),
    fixtureSidecar(),
  );
  writeFileSync(
    at('reports', 'stryker-incremental.json'),
    JSON.stringify({
      files: {
        'src/foo.ts': {
          source: '',
          mutants: [
            {
              mutatorName: 'BlockStatement',
              status: 'Killed',
              killedBy: ['t'],
              coveredBy: ['t'],
              location: { start: { line: 1, column: 1 } },
            },
          ],
        },
      },
      testFiles: { 'test/foo.test.ts': { tests: [{ id: 't', name: 'foo' }] } },
    }),
  );
  writeFileSync(at('test', 'foo.test.ts'), '');
  utimesSync(
    at('test', 'foo.test.ts'),
    new Date(1_000_000),
    new Date(1_000_000),
  );
  utimesSync(
    at('reports', 'stryker-incremental.json'),
    new Date(2_000_000),
    new Date(2_000_000),
  );
}

/**
How many kills the gate left in the fixture's cache; -1 for no cache.
*/
export function keptKills(root: string): number {
  const cachePath = path.join(root, 'reports', 'stryker-incremental.json');
  const cache =
    existsSync(cachePath) &&
    parseIncrementalCache(readFileSync(cachePath, 'utf8'));
  if (cache === false) {
    return -1;
  }
  return cache?.files.get('src/foo.ts')?.mutants.length ?? -1;
}

/**
The `mutationCache.seedFrom` command the seeding fixture answers to.
*/
export const SEED_COMMAND = 'fetch-ci-reports';

/**
 * The cache fixture as a FRESH worktree sees it (#157): everything in place
 * but the cache itself, so a gate that seeds writes one and a gate that does
 * not leaves none.
 */
export function writeSeedFixture(root: string): void {
  writeCacheFixture(root);
  rmSync(path.join(root, 'reports', 'stryker-incremental.json'));
  const otherTest = path.join(root, 'test', 'other.test.ts');
  writeFileSync(otherTest, '');
  utimesSync(otherTest, new Date(1_000_000), new Date(1_000_000));
}

/**
 * The CI report the fake `seedFrom` command "downloads": one kill of
 * `src/foo.ts`, by a test in a file the fixture's branch did NOT change — so
 * the targeted rule keeps it, and a seeded gate leaves one kill.
 */
const SEED_REPORT = JSON.stringify({
  files: {
    'src/foo.ts': {
      source: '',
      mutants: [
        {
          mutatorName: 'BlockStatement',
          status: 'Killed',
          killedBy: ['0'],
          coveredBy: ['0'],
          location: { start: { line: 1, column: 1 } },
        },
      ],
    },
  },
  testFiles: { 'test/other.test.ts': { tests: [{ id: '0', name: 'other' }] } },
});

/**
 * An `Exec` that answers the gate's `git diff --name-only` with the fixture's
 * change set, and plays a `seedFrom` command: `sh -c SEED_COMMAND` writes the
 * CI report, and the fingerprint CI uploads beside it, into
 * `$GUARDRAILS_SEED_DIR`. Anything else, stryker included,
 * does nothing.
 */
export const seedFixtureExec: Exec = (command, args, options) => {
  const seedDirectory = options?.env?.GUARDRAILS_SEED_DIR;
  if (
    seedDirectory !== undefined &&
    command === 'sh' &&
    args.join(' ') === `-c ${SEED_COMMAND}`
  ) {
    writeFileSync(path.join(seedDirectory, 'report.json'), SEED_REPORT);
    writeFileSync(
      path.join(seedDirectory, 'report.fingerprint.json'),
      fixtureSidecar(),
    );
  }
  return Promise.resolve({
    stdout: args.includes('--name-only') ? CHANGED_FILES : '',
    stderr: '',
    code: 0,
  });
};

/**
 * The support-change fixture's change set (#197): both mutated files and a
 * helper only `test/foo.test.ts` imports. No test file changed.
 */
export const SUPPORT_CHANGED_FILES =
  'src/foo.ts\nsrc/bar.ts\ntest/helpers.ts\n';

function killedBy(test: string): unknown {
  return {
    source: '',
    mutants: [
      {
        mutatorName: 'BlockStatement',
        status: 'Killed',
        killedBy: [test],
        coveredBy: [test],
        location: { start: { line: 1, column: 1 } },
      },
    ],
  };
}

/**
 * The cache fixture with a second mutated file and a second test (#197):
 * `src/foo.ts` killed by `test/foo.test.ts`, which imports `test/helpers.ts`,
 * and `src/bar.ts` killed by `test/bar.test.ts`, which imports nothing. The
 * repo's TypeScript is this one's, linked in, so the gate traces the graph
 * with a real resolver. A gate that traces it drops foo's kill and keeps
 * bar's; one that cannot discards both.
 */
export function writeSupportFixture(root: string): void {
  writeCacheFixture(root);
  const at = (...parts: string[]) => path.join(root, ...parts);
  writeFileSync(
    at('reports', 'stryker-incremental.json'),
    JSON.stringify({
      files: { 'src/foo.ts': killedBy('t'), 'src/bar.ts': killedBy('u') },
      testFiles: {
        'test/foo.test.ts': { tests: [{ id: 't', name: 'foo' }] },
        'test/bar.test.ts': { tests: [{ id: 'u', name: 'bar' }] },
      },
    }),
  );
  writeFileSync(at('test', 'helpers.ts'), 'export const h = 1;\n');
  writeFileSync(
    at('test', 'foo.test.ts'),
    "import { h } from './helpers.js';\n",
  );
  writeFileSync(at('test', 'bar.test.ts'), 'export const b = 1;\n');
  for (const test of ['foo.test.ts', 'bar.test.ts']) {
    utimesSync(at('test', test), new Date(1_000_000), new Date(1_000_000));
  }
  utimesSync(
    at('reports', 'stryker-incremental.json'),
    new Date(2_000_000),
    new Date(2_000_000),
  );
  const typescript = path.dirname(
    createRequire(import.meta.url).resolve('typescript/package.json'),
  );
  symlinkSync(typescript, at('node_modules', 'typescript'), 'dir');
}

/**
How many kills the gate left for `file`; -1 for no cache or no entry.
*/
export function keptKillsOf(root: string, file: string): number {
  const cachePath = path.join(root, 'reports', 'stryker-incremental.json');
  const cache = existsSync(cachePath)
    ? parseIncrementalCache(readFileSync(cachePath, 'utf8'))
    : undefined;
  return cache?.files.get(file)?.mutants.length ?? -1;
}
