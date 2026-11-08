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
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  const cache = parseIncrementalCache(
    readFileSync(
      path.join(root, 'reports', 'stryker-incremental.json'),
      'utf8',
    ),
  );
  return cache?.files.get('src/foo.ts')?.mutants.length ?? -1;
}
