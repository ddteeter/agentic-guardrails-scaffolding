/**
 * The docs an adopter (or their agent) copies commands from must never say
 * `npx guardrails`. npx resolves a bin NAME, and this package's bin is
 * `guardrails-core`, so `npx guardrails` can never reach it: it falls through to
 * the registry and runs `guardrails@2.4.1`, an unrelated package owned by
 * someone else. That happened on 2026-11-07, from `docs/adoption.md`'s own ship
 * advice. The bin rename (see `package-exports.test.ts`) closed the hole in the
 * package; this closes it in the prose, which nothing checked before.
 *
 * Design docs under `docs/superpowers/` are history and may quote the bad
 * form to explain it, so they are not scanned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.join(import.meta.dirname, '..', '..');

function markdownUnder(directory: string): string[] {
  return readdirSync(path.join(repoRoot, directory), {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.join(directory, entry));
}

const scanned = [
  'README.md',
  ...readdirSync(path.join(repoRoot, 'docs'))
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.join('docs', entry)),
  ...markdownUnder('guardrails-plugin'),
];

const BARE_NPX = /\bnpx\s+guardrails(?!-core)\b/;

describe('adopter-facing docs', () => {
  it('scans the files it means to', () => {
    expect(scanned).toContain(path.join('docs', 'adoption.md'));
    expect(scanned.some((file) => file.startsWith('guardrails-plugin'))).toBe(
      true,
    );
  });

  it.each(scanned)('%s never tells anyone to run `npx guardrails`', (file) => {
    const offending = readFileSync(path.join(repoRoot, file), 'utf8')
      .split('\n')
      .filter((line) => BARE_NPX.test(line));
    expect(offending).toEqual([]);
  });
});
