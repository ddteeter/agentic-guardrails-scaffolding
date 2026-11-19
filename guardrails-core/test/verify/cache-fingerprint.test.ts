import { describe, expect, it } from 'vitest';

import {
  computeFingerprint,
  type FingerprintInputs,
  fingerprintDifference,
  isSameFingerprint,
  serializeFingerprint,
  strykerVersionFrom,
  parseFingerprint,
  verdictOptions,
} from '../../src/verify/cache-fingerprint.js';

const inputs: FingerprintInputs = {
  strykerVersion: '10.0.0',
  config: '{"testRunner":"vitest"}',
  dependencies: {
    lockfiles: [
      { name: 'package-lock.json', contents: '{"lockfileVersion":3}' },
    ],
  },
};

function withLockfiles(
  lockfiles: { name: string; contents: string }[],
): Partial<FingerprintInputs> {
  return { dependencies: { lockfiles } };
}

function sidecarFor(overrides: Partial<FingerprintInputs> = {}): string {
  const fingerprint = computeFingerprint({ ...inputs, ...overrides });
  if (fingerprint === undefined) {
    throw new Error('fixture has no fingerprint');
  }
  return serializeFingerprint(fingerprint);
}

describe('computeFingerprint', () => {
  it('records the stryker version and hashes of the options and dependencies', () => {
    expect(computeFingerprint(inputs)).toEqual({
      stryker: '10.0.0',
      options: expect.stringMatching(/^[\da-f]{64}$/),
      dependencies: expect.stringMatching(/^[\da-f]{64}$/),
    });
  });

  it('tells pinned versions apart from a lockfile with the same text', () => {
    const pinned = computeFingerprint({
      ...inputs,
      dependencies: { pins: ['package-lock.json'] },
    });
    const locked = computeFingerprint({
      ...inputs,
      ...withLockfiles([{ name: 'package-lock.json', contents: '' }]),
    });
    expect(pinned?.dependencies).not.toBe(locked?.dependencies);
  });

  it('does not depend on the order the pins were found in', () => {
    const one = computeFingerprint({
      ...inputs,
      dependencies: { pins: ['a@1.0.0', 'b@2.0.0'] },
    });
    const other = computeFingerprint({
      ...inputs,
      dependencies: { pins: ['b@2.0.0', 'a@1.0.0'] },
    });
    expect(one?.dependencies).toBe(other?.dependencies);
  });

  it('has no fingerprint when the stryker version cannot be read', () => {
    // An unknown version cannot be compared, and a fingerprint that matched
    // "unknown" to "unknown" would keep a cache across a stryker upgrade.
    expect(
      computeFingerprint({ ...inputs, strykerVersion: undefined }),
    ).toBeUndefined();
    expect(
      computeFingerprint({ ...inputs, strykerVersion: '' }),
    ).toBeUndefined();
  });

  it('tells a lockfile apart from the same text under another name', () => {
    // A switch from npm to pnpm is a dependency change even if nothing else is.
    const npm = computeFingerprint(inputs);
    const pnpm = computeFingerprint({
      ...inputs,
      ...withLockfiles([
        { name: 'pnpm-lock.yaml', contents: '{"lockfileVersion":3}' },
      ]),
    });
    expect(npm?.dependencies).not.toBe(pnpm?.dependencies);
  });

  it('does not let two lockfiles run together into one', () => {
    const split = computeFingerprint({
      ...inputs,
      ...withLockfiles([
        { name: 'a', contents: 'bc' },
        { name: 'd', contents: '' },
      ]),
    });
    const joined = computeFingerprint({
      ...inputs,
      ...withLockfiles([
        { name: 'a', contents: 'b' },
        { name: 'cd', contents: '' },
      ]),
    });
    expect(split?.dependencies).not.toBe(joined?.dependencies);
  });
});

describe('isSameFingerprint', () => {
  const current = computeFingerprint(inputs);

  it('matches the sidecar written for the same inputs', () => {
    expect(isSameFingerprint(sidecarFor(), current)).toBe(true);
  });

  it.each<[string, Partial<FingerprintInputs>]>([
    ['the stryker version', { strykerVersion: '10.1.1' }],
    ['the stryker config', { config: '{"testRunner":"command"}' }],
    [
      'the lockfile',
      withLockfiles([{ name: 'package-lock.json', contents: '{}' }]),
    ],
    ['which lockfiles exist', withLockfiles([])],
    ['a pinned version', { dependencies: { pins: ['vitest@4.1.0'] } }],
  ])('does not match once %s changes', (_label, overrides) => {
    expect(isSameFingerprint(sidecarFor(overrides), current)).toBe(false);
  });

  it('does not match a missing sidecar, which reads as the empty string', () => {
    expect(isSameFingerprint('', current)).toBe(false);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[]'],
    [
      'a field of the wrong type',
      '{"stryker":10,"options":"","dependencies":""}',
    ],
    ['a missing field', '{"stryker":"10.0.0","options":"x"}'],
    [
      'written before #177, under the old field names',
      '{"stryker":"10.0.0","config":"c","lockfile":"l"}',
    ],
  ])('does not match a sidecar that is %s', (_label, sidecar) => {
    expect(isSameFingerprint(sidecar, current)).toBe(false);
  });

  it('matches nothing when this run has no fingerprint', () => {
    expect(isSameFingerprint(sidecarFor(), undefined)).toBe(false);
  });
});

describe('strykerVersionFrom', () => {
  it('reads the version out of a package manifest', () => {
    expect(
      strykerVersionFrom('{"name":"@stryker-mutator/core","version":"10.0.0"}'),
    ).toBe('10.0.0');
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '"10.0.0"'],
    ['a manifest with no version', '{"name":"x"}'],
    ['a numeric version', '{"version":10}'],
  ])('reads no version from %s', (_label, manifest) => {
    expect(strykerVersionFrom(manifest)).toBeUndefined();
  });
});

describe('parseFingerprint', () => {
  const whole = { stryker: '10.0.0', options: 'o', dependencies: 'd' };

  it('reads a sidecar holding all three fields', () => {
    expect(parseFingerprint(JSON.stringify(whole))).toEqual(whole);
  });

  it.each(['stryker', 'options', 'dependencies'])(
    'rejects a sidecar whose %s is not a string',
    (field) => {
      expect(
        parseFingerprint(JSON.stringify({ ...whole, [field]: 1 })),
      ).toBeUndefined();
    },
  );

  it('rejects text that is not an object', () => {
    expect(parseFingerprint('[]')).toBeUndefined();
  });
});

const of = (config: unknown): string => verdictOptions(JSON.stringify(config));

describe('verdictOptions (#177)', () => {
  const base = {
    testRunner: 'vitest',
    vitest: { configFile: 'vitest.config.ts' },
    mutate: ['src/a.ts'],
    reporters: ['json'],
    timeoutMS: 5000,
  };

  it.each<[string, Record<string, unknown>]>([
    ['a mutate entry', { mutate: ['src/a.ts', 'src/b.ts'] }],
    ['the reporters', { reporters: ['json', 'html'] }],
    ['a reporter block', { htmlReporter: { fileName: 'x.html' } }],
    ['the thresholds', { thresholds: { break: 100 } }],
    ['the concurrency', { concurrency: 2 }],
    ['the log level', { logLevel: 'debug', fileLogLevel: 'trace' }],
    ['the incremental file', { incremental: true, incrementalFile: 'x.json' }],
    ['the temp directory', { tempDirName: 't', cleanTempDir: false }],
    ['the schema', { $schema: 'https://example.test/schema.json' }],
    [
      'the other no-verdict keys',
      {
        jsonReporter: {},
        clearTextReporter: {},
        dashboard: {},
        eventReporter: {},
        allowConsoleColors: false,
        force: true,
        dryRunOnly: false,
      },
    ],
  ])('is the same when only %s changes', (_label, change) => {
    expect(of({ ...base, ...change })).toBe(of(base));
  });

  it.each<[string, Record<string, unknown>]>([
    ['the mutators', { mutator: { excludedMutations: ['Regex'] } }],
    ['the timeout', { timeoutMS: 10_000 }],
    ['the timeout factor', { timeoutFactor: 3 }],
    ['the test runner', { testRunner: 'jest' }],
    ['the runner config', { vitest: { configFile: 'other.config.ts' } }],
    ['the coverage analysis', { coverageAnalysis: 'all' }],
    ['the checkers', { checkers: ['typescript'] }],
    ['the plugins', { plugins: ['@stryker-mutator/vitest-runner'] }],
    ['an option this list does not know', { somethingNew: 1 }],
  ])('differs when %s changes', (_label, change) => {
    expect(of({ ...base, ...change })).not.toBe(of(base));
  });

  it('does not depend on key order, at any depth', () => {
    expect(of({ vitest: { b: 1, a: 2 }, testRunner: 'vitest' })).toBe(
      of({ testRunner: 'vitest', vitest: { a: 2, b: 1 } }),
    );
  });

  it('tells an array apart from an object keyed by its indexes', () => {
    expect(of({ plugins: ['a'] })).not.toBe(of({ plugins: { 0: 'a' } }));
  });

  it('ignores key order inside the objects an array holds', () => {
    expect(of({ checkers: [{ b: 1, a: 2 }] })).toBe(
      of({ checkers: [{ a: 2, b: 1 }] }),
    );
  });

  it('keeps array order, which can matter', () => {
    expect(of({ plugins: ['a', 'b'] })).not.toBe(of({ plugins: ['b', 'a'] }));
  });

  it.each([
    ['not JSON', 'module.exports = {}'],
    ['not an object', '["a"]'],
    ['null', 'null'],
  ])('is the text itself when the config is %s', (_label, text) => {
    expect(verdictOptions(text)).toBe(text);
  });

  it('keeps a fingerprint stable across a mutate-only change', () => {
    const one = computeFingerprint({
      ...inputs,
      config: JSON.stringify(base),
    });
    const other = computeFingerprint({
      ...inputs,
      config: JSON.stringify({ ...base, mutate: ['src/z.ts'] }),
    });
    expect(one).toEqual(other);
  });
});

describe('fingerprintDifference (#177)', () => {
  const whole = { stryker: '10.0.0', options: 'o', dependencies: 'd' };

  it('is empty for equal fingerprints', () => {
    expect(fingerprintDifference(whole, { ...whole })).toEqual([]);
  });

  it('names each field that differs, in field order', () => {
    expect(
      fingerprintDifference(whole, {
        stryker: '10.1.0',
        options: 'o',
        dependencies: 'x',
      }),
    ).toEqual(['stryker', 'dependencies']);
    expect(fingerprintDifference(whole, { ...whole, options: 'p' })).toEqual([
      'options',
    ]);
  });
});
