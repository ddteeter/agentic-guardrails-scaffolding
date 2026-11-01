import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { legacyFingerprints } from '../../src/scaffold/templates.js';

/**
 * The bundled checksum -> fingerprint table for manifests written before
 * fingerprints were recorded (0.11.1 and earlier). Generated once by
 * `scripts/legacy-fingerprints.mjs` from the release tags.
 */
describe('legacyFingerprints', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('carries the 0.11.0 guardrail-fixer.md that dialed.run was stuck on', () => {
    // Both hashes taken from `git show v0.11.0:guardrails-core/templates/
    // claude/agents/guardrail-fixer.md`. A regenerated table that lost this
    // pair would leave that install drifted again.
    expect(
      legacyFingerprints()[
        'sha256-4bc9cab1dd60f0da165a5acd8ed7afd5b81c8268a93706568e6e65296e532ead'
      ],
    ).toBe(
      'words-sha256-b04137df80a9a89aad5cdaf3ef138b632fffd60eadae870de93bdca16581fa0e',
    );
  });

  it('holds only checksum -> fingerprint pairs', () => {
    const entries = Object.entries(legacyFingerprints());
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value] of entries) {
      expect(key).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(value).toMatch(/^words-sha256-[0-9a-f]{64}$/);
    }
  });

  it('reads as empty when the table is missing or malformed', () => {
    // Empty is the safe direction: every reformat reads as an edit, which is
    // the behaviour before the table existed.
    scratch = mkdtempSync(path.join(tmpdir(), 'legacy-fingerprints-'));
    expect(legacyFingerprints(path.join(scratch, 'absent.json'))).toEqual({});
    const malformed = path.join(scratch, 'malformed.json');
    writeFileSync(malformed, '["not", "a", "map"]');
    expect(legacyFingerprints(malformed)).toEqual({});
    const mixed = path.join(scratch, 'mixed.json');
    writeFileSync(mixed, JSON.stringify({ good: 'words-sha256-x', bad: 7 }));
    expect(legacyFingerprints(mixed)).toEqual({ good: 'words-sha256-x' });
  });
});
