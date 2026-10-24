import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

import {
  checksum,
  fingerprint,
  isUnmodified,
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

describe('fingerprint', () => {
  const words = 'Read the manifest, then fix each violation.';

  it.each([
    ['re-wrapped', 'Read the manifest,\nthen fix each violation.'],
    ['re-indented', '  Read  the manifest, then fix each violation.  \n'],
    ['re-quoted', 'Read the "manifest", then fix each violation.'],
    ['re-punctuated', 'Read the manifest; then fix each violation,'],
    ['re-marked', '- _Read_ the **manifest**, then fix each violation.'],
    ['re-cased', 'READ the manifest, then fix each violation.'],
  ])('ignores a formatter-only change: %s', (_case, reformatted) => {
    expect(fingerprint(reformatted)).toBe(fingerprint(words));
  });

  it.each([
    ['a changed word', words, 'Read the manifest, then skip each violation.'],
    [
      'an added word',
      words,
      'Read the manifest, then fix every violation now.',
    ],
    ['a changed digit', 'Retry 2 times.', 'Retry 3 times.'],
  ])('changes on %s', (_case, original, edited) => {
    expect(fingerprint(edited)).not.toBe(fingerprint(original));
  });

  it('keeps non-ASCII letters, so a translated edit still counts', () => {
    expect(fingerprint('café')).not.toBe(fingerprint('caf'));
  });

  it('hashes the lowercased letters and digits, a value the legacy table persists', () => {
    expect(fingerprint('Ab, 1!')).toBe(`words-${checksum('ab1')}`);
  });

  it('is prefixed so the committed manifest says what it used', () => {
    expect(fingerprint(words)).toMatch(/^words-sha256-[0-9a-f]{64}$/);
  });

  it('matches the fixer template after a default-config Prettier run', async () => {
    // dialed.run, 2026-10-24: lint-staged Prettier reformatted the fixer's
    // fenced ts block ('number' -> "number"), and init then read the file as
    // hand-edited and stopped upgrading it.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const template = readFileSync(
      path.join(here, '../../templates/claude/agents/guardrail-fixer.md'),
      'utf8',
    );
    const reformatted = await format(template, { parser: 'markdown' });
    expect(reformatted).not.toBe(template);
    expect(fingerprint(reformatted)).toBe(fingerprint(template));
  });
});

describe('isUnmodified', () => {
  const PATH = '.claude/agents/guardrail-fixer.md';
  const WRITTEN = "Use typeof x !== 'number' here.\n";
  const REFORMATTED = 'Use typeof x !== "number" here.\n';
  const REWORDED = "Use typeof x !== 'string' here.\n";

  it('holds on an exact checksum match', () => {
    const manifest = {
      guardrailsVersion: '0.12.0',
      files: { [PATH]: checksum(WRITTEN) },
    };
    expect(isUnmodified(PATH, WRITTEN, manifest, {})).toBe(true);
  });

  it('holds for a reformat, against the recorded fingerprint', () => {
    const manifest = {
      guardrailsVersion: '0.12.0',
      files: { [PATH]: checksum(WRITTEN) },
      fingerprints: { [PATH]: fingerprint(WRITTEN) },
    };
    expect(isUnmodified(PATH, REFORMATTED, manifest, {})).toBe(true);
    expect(isUnmodified(PATH, REWORDED, manifest, {})).toBe(false);
  });

  it('holds for a reformat of a pre-fingerprint install, via the legacy table', () => {
    const manifest = {
      guardrailsVersion: '0.11.1',
      files: { [PATH]: checksum(WRITTEN) },
    };
    const legacy = { [checksum(WRITTEN)]: fingerprint(WRITTEN) };
    expect(isUnmodified(PATH, REFORMATTED, manifest, legacy)).toBe(true);
    expect(isUnmodified(PATH, REFORMATTED, manifest, {})).toBe(false);
    expect(isUnmodified(PATH, REWORDED, manifest, legacy)).toBe(false);
  });

  it('never holds for an unrecorded path, whatever fingerprints say', () => {
    // A fingerprint entry without a files entry is not a record of a write.
    const withFingerprint = {
      guardrailsVersion: '0.12.0',
      files: {},
      fingerprints: { [PATH]: fingerprint(WRITTEN) },
    };
    expect(isUnmodified(PATH, REFORMATTED, withFingerprint, {})).toBe(false);
    expect(isUnmodified(PATH, WRITTEN, withFingerprint, {})).toBe(false);
    // The legacy table is keyed by checksum; an absent record must not look
    // itself up under the string 'undefined'.
    const legacy = { undefined: fingerprint(WRITTEN) };
    expect(isUnmodified(PATH, WRITTEN, undefined, legacy)).toBe(false);
    expect(
      isUnmodified(
        PATH,
        WRITTEN,
        { guardrailsVersion: '0.12.0', files: {} },
        legacy,
      ),
    ).toBe(false);
  });

  it('never holds for a file the manifest does not record', () => {
    // Words alone must not vouch for a file: matching some fingerprint is not
    // proof guardrails wrote it here.
    const legacy = { [checksum(WRITTEN)]: fingerprint(WRITTEN) };
    expect(isUnmodified(PATH, WRITTEN, undefined, legacy)).toBe(false);
    expect(
      isUnmodified(
        PATH,
        WRITTEN,
        { guardrailsVersion: '0.12.0', files: {} },
        legacy,
      ),
    ).toBe(false);
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

describe('parseManifest — fingerprints', () => {
  it('reads the fingerprints map', () => {
    expect(
      parseManifest({
        guardrailsVersion: '0.12.0',
        files: { 'a.md': 'sha256-x' },
        fingerprints: { 'a.md': 'words-sha256-w' },
      }),
    ).toEqual({
      guardrailsVersion: '0.12.0',
      files: { 'a.md': 'sha256-x' },
      fingerprints: { 'a.md': 'words-sha256-w' },
    });
  });

  it('reads a pre-fingerprint manifest without inventing a map', () => {
    expect(
      parseManifest({ guardrailsVersion: '0.11.1', files: { 'a.md': 'x' } }),
    ).toEqual({ guardrailsVersion: '0.11.1', files: { 'a.md': 'x' } });
  });

  it('drops a malformed map and non-string entries', () => {
    // Same safe direction as `files`: an untrusted fingerprint can only make a
    // file read as drifted, never as unmodified.
    expect(
      parseManifest({
        guardrailsVersion: '0.12.0',
        files: {},
        fingerprints: [],
      }),
    ).toEqual({ guardrailsVersion: '0.12.0', files: {} });
    expect(
      parseManifest({
        guardrailsVersion: '0.12.0',
        files: {},
        fingerprints: { good: 'words-sha256-w', bad: 7 },
      }),
    ).toEqual({
      guardrailsVersion: '0.12.0',
      files: {},
      fingerprints: { good: 'words-sha256-w' },
    });
  });
});

describe('serializeManifest', () => {
  it('round-trips the fingerprints map with sorted keys', () => {
    const manifest = {
      guardrailsVersion: '0.12.0',
      files: { 'a.md': 'sha256-x', 'b.md': 'sha256-y' },
      fingerprints: { 'b.md': 'words-sha256-v', 'a.md': 'words-sha256-w' },
    };
    const text = serializeManifest(manifest);
    expect(parseManifest(JSON.parse(text))).toEqual(manifest);
    const map = text.slice(text.indexOf('"fingerprints"'));
    expect(map.indexOf('a.md')).toBeLessThan(map.indexOf('b.md'));
  });

  it('omits an empty map, so pre-fingerprint manifests do not churn', () => {
    const text = serializeManifest({
      guardrailsVersion: '0.12.0',
      files: {},
      fingerprints: {},
    });
    expect(text).not.toContain('fingerprints');
  });

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
