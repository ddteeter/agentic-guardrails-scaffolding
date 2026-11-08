import { describe, expect, it } from 'vitest';

import { isTestSpecFile, isTestSupportFile } from '../../src/verify/git.js';

describe('isTestSpecFile', () => {
  it.each([
    'src/a.test.ts',
    'test/a.spec.tsx',
    'a.test.mts',
    'a.test.js',
    'a.spec.cjs',
  ])('is true for the spec file %s', (file) => {
    expect(isTestSpecFile(file)).toBe(true);
  });

  it.each(['test/helpers.ts', 'src/a.ts', 'src/latest.ts', 'a.test.ts.snap'])(
    'is false for %s, which declares no tests of its own',
    (file) => {
      expect(isTestSpecFile(file)).toBe(false);
    },
  );
});

/**
 * Code the tests run that is not itself a test. A change here can weaken a
 * test that killed a mutant without touching that test's own file, so the
 * targeted cache rule — which asks only "did the killing test's file change?"
 * — cannot vouch for anything, and the whole cache goes.
 */
describe('isTestSupportFile', () => {
  it.each([
    ['a helper under a test directory', 'guardrails-core/test/helpers.ts'],
    ['a fixture under __tests__', 'src/__tests__/fixture.json'],
    ['a manual mock', 'src/__mocks__/fs.ts'],
    ['a snapshot', 'src/__snapshots__/a.test.ts.snap'],
    ['a snapshot outside a snapshot directory', 'src/a.test.ts.snap'],
    ['a fixtures directory', 'src/fixtures/user.ts'],
    ['a vitest setup file', 'vitest.setup.ts'],
    ['a setup file named for what it sets up', 'src/setupTests.ts'],
    ['a test-utils module', 'src/test-utils.ts'],
    ['a test_helpers module', 'src/lib/test_helpers.tsx'],
    ['a testUtils module', 'src/testUtils.js'],
    ['a config the test runner reads', 'vitest.config.ts'],
  ])('is true for %s', (_label, file) => {
    expect(isTestSupportFile(file)).toBe(true);
  });

  it.each([
    ['a spec file', 'guardrails-core/test/a.test.ts'],
    ['production code', 'src/a.ts'],
    ['production that only sounds like a test', 'src/testing/latest.ts'],
    ['production named for a contest', 'src/contest.ts'],
    ['production utilities that are not test utilities', 'src/string-utils.ts'],
    ['a script named for a test directory', 'scripts/test'],
    ['documentation', 'docs/a.md'],
    ['a manifest', 'package.json'],
  ])('is false for %s', (_label, file) => {
    expect(isTestSupportFile(file)).toBe(false);
  });
});
