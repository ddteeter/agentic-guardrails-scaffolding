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
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

export function writeCacheFixture(root: string): void {
  const at = (...parts: string[]) => path.join(root, ...parts);
  const config = JSON.stringify({ testRunner: 'vitest' });
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
  const fingerprint = computeFingerprint({
    strykerVersion: '10.0.0',
    config,
    lockfiles: [],
  });
  writeFileSync(
    at('reports', 'stryker-incremental.fingerprint.json'),
    fingerprint === undefined ? '' : serializeFingerprint(fingerprint),
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
 * CI report into `$GUARDRAILS_SEED_DIR`. Anything else, stryker included,
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
  }
  return Promise.resolve({
    stdout: args.includes('--name-only') ? CHANGED_FILES : '',
    stderr: '',
    code: 0,
  });
};
