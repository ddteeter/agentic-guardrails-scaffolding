import { describe, expect, it } from 'vitest';

import {
  checksum,
  MANIFEST_PATH,
  parseManifest,
  serializeManifest,
} from '../../src/scaffold/manifest.js';

describe('checksum', () => {
  it('is stable for identical content', () => {
    expect(checksum('hello')).toBe(checksum('hello'));
  });

  it('differs for different content', () => {
    expect(checksum('hello')).not.toBe(checksum('hello '));
  });

  it('is prefixed so the algorithm is visible in the committed file', () => {
    expect(checksum('hello')).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

describe('parseManifest', () => {
  it('reads a well-formed manifest', () => {
    expect(
      parseManifest({
        guardrailsVersion: '0.1.0',
        files: { 'a.md': 'sha256-x' },
      }),
    ).toEqual({ guardrailsVersion: '0.1.0', files: { 'a.md': 'sha256-x' } });
  });

  it('rejects a non-object', () => {
    expect(parseManifest(undefined)).toBeUndefined();
    expect(parseManifest('nope')).toBeUndefined();
    expect(parseManifest(null)).toBeUndefined();
    expect(parseManifest([])).toBeUndefined();
  });

  it('rejects a missing or non-string version', () => {
    expect(parseManifest({ files: {} })).toBeUndefined();
    expect(parseManifest({ guardrailsVersion: 1, files: {} })).toBeUndefined();
  });

  it('rejects a missing or non-object files map', () => {
    expect(parseManifest({ guardrailsVersion: '0.1.0' })).toBeUndefined();
    expect(
      parseManifest({ guardrailsVersion: '0.1.0', files: [] }),
    ).toBeUndefined();
  });

  it('drops entries whose checksum is not a string', () => {
    // A malformed entry must not be trusted as "unmodified" — dropping it makes
    // the file read as untracked, which is the safe direction: init reports
    // drift rather than silently overwriting a consumer's edit.
    expect(
      parseManifest({
        guardrailsVersion: '0.1.0',
        files: { good: 'sha256-x', bad: 7 },
      }),
    ).toEqual({ guardrailsVersion: '0.1.0', files: { good: 'sha256-x' } });
  });
});

describe('serializeManifest', () => {
  it('round-trips through parseManifest', () => {
    const manifest = {
      guardrailsVersion: '0.1.0',
      files: { 'b.md': 'sha256-y' },
    };
    expect(parseManifest(JSON.parse(serializeManifest(manifest)))).toEqual(
      manifest,
    );
  });

  it('emits deterministic output with sorted keys and a trailing newline', () => {
    // Determinism keeps the committed manifest out of every diff and lets a CI
    // drift-check work on it.
    const one = serializeManifest({
      guardrailsVersion: '0.1.0',
      files: { 'b.md': 'sha256-y', 'a.md': 'sha256-x' },
    });
    const two = serializeManifest({
      guardrailsVersion: '0.1.0',
      files: { 'a.md': 'sha256-x', 'b.md': 'sha256-y' },
    });
    expect(one).toBe(two);
    expect(one.endsWith('\n')).toBe(true);
    expect(one.indexOf('a.md')).toBeLessThan(one.indexOf('b.md'));
  });

  it('carries no timestamp', () => {
    const text = serializeManifest({ guardrailsVersion: '0.1.0', files: {} });
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('MANIFEST_PATH', () => {
  it('sits beside the gitignored state directory, not inside it', () => {
    // .gitignore ignores `.guardrails/state/`; the manifest must be committed.
    expect(MANIFEST_PATH).toBe('.guardrails/scaffold.json');
  });
});
