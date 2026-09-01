import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractVersion,
  packageRoot,
  packageVersion,
} from '../src/package-root.js';

describe('packageVersion', () => {
  it("reads the version from guardrails-core's own package.json", () => {
    // Not hardcoded to today's version: reads the same file this module
    // resolves against, so a version bump can never desync this assertion
    // from what `packageVersion` actually returns.
    const raw = readFileSync(path.join(packageRoot(), 'package.json'), 'utf8');
    const { version } = JSON.parse(raw) as { version: string };
    expect(packageVersion()).toBe(version);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// `packageVersion()` always reads the REAL installed package.json, which
// can't be corrupted just to exercise its fallback branches -- `extractVersion`
// is the pure decision `packageVersion` delegates to, split out specifically
// so those branches (missing, malformed, non-string version) are provable
// directly instead of only covered incidentally by the happy path above.
describe('extractVersion', () => {
  it('returns the version from a valid parsed package.json', () => {
    expect(extractVersion({ name: 'x', version: '1.2.3' })).toBe('1.2.3');
  });

  it('returns "" when parsed is not a record (missing/malformed file)', () => {
    expect(extractVersion(undefined)).toBe('');
  });

  it('returns "" when parsed is an array', () => {
    // `typeof [] === 'object'`: without excluding arrays explicitly, this
    // would read `.version` off an array and pass the `isRecord` guard.
    expect(extractVersion(['not', 'a', 'record'])).toBe('');
  });

  it('returns "" when parsed is null', () => {
    // `typeof null === 'object'` too.
    expect(extractVersion(null)).toBe('');
  });

  it('returns "" when the record has no version field', () => {
    expect(extractVersion({ name: 'x' })).toBe('');
  });

  it('returns "" when version is present but not a string', () => {
    expect(extractVersion({ version: 123 })).toBe('');
  });
});
