import { describe, expect, it } from 'vitest';

import {
  computeFingerprint,
  isSameFingerprint,
  serializeFingerprint,
  strykerVersionFrom,
  parseFingerprint,
} from '../../src/verify/cache-fingerprint.js';

const inputs = {
  strykerVersion: '10.0.0',
  config: '{"testRunner":"vitest"}',
  lockfiles: [{ name: 'package-lock.json', contents: '{"lockfileVersion":3}' }],
};

function sidecarFor(overrides: Partial<typeof inputs> = {}): string {
  const fingerprint = computeFingerprint({ ...inputs, ...overrides });
  if (fingerprint === undefined) {
    throw new Error('fixture has no fingerprint');
  }
  return serializeFingerprint(fingerprint);
}

describe('computeFingerprint', () => {
  it('records the stryker version and hashes of the config and lockfiles', () => {
    expect(computeFingerprint(inputs)).toEqual({
      stryker: '10.0.0',
      config: expect.stringMatching(/^[\da-f]{64}$/),
      lockfile: expect.stringMatching(/^[\da-f]{64}$/),
    });
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
      lockfiles: [
        { name: 'pnpm-lock.yaml', contents: '{"lockfileVersion":3}' },
      ],
    });
    expect(npm?.lockfile).not.toBe(pnpm?.lockfile);
  });

  it('does not let two lockfiles run together into one', () => {
    const split = computeFingerprint({
      ...inputs,
      lockfiles: [
        { name: 'a', contents: 'bc' },
        { name: 'd', contents: '' },
      ],
    });
    const joined = computeFingerprint({
      ...inputs,
      lockfiles: [
        { name: 'a', contents: 'b' },
        { name: 'cd', contents: '' },
      ],
    });
    expect(split?.lockfile).not.toBe(joined?.lockfile);
  });
});

describe('isSameFingerprint', () => {
  const current = computeFingerprint(inputs);

  it('matches the sidecar written for the same inputs', () => {
    expect(isSameFingerprint(sidecarFor(), current)).toBe(true);
  });

  it.each([
    ['the stryker version', { strykerVersion: '10.1.1' }],
    ['the stryker config', { config: '{"testRunner":"command"}' }],
    [
      'the lockfile',
      { lockfiles: [{ name: 'package-lock.json', contents: '{}' }] },
    ],
    ['which lockfiles exist', { lockfiles: [] }],
  ])('does not match once %s changes', (_label, overrides) => {
    expect(isSameFingerprint(sidecarFor(overrides), current)).toBe(false);
  });

  it('does not match a missing sidecar, which reads as the empty string', () => {
    expect(isSameFingerprint('', current)).toBe(false);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[]'],
    ['a field of the wrong type', '{"stryker":10,"config":"","lockfile":""}'],
    ['a missing field', '{"stryker":"10.0.0","config":"x"}'],
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
  const whole = { stryker: '10.0.0', config: 'c', lockfile: 'l' };

  it('reads a sidecar holding all three fields', () => {
    expect(parseFingerprint(JSON.stringify(whole))).toEqual(whole);
  });

  it.each(['stryker', 'config', 'lockfile'])(
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
