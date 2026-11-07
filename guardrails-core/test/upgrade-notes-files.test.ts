import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseUpgradeNotes } from '../src/upgrade-notes.js';

/*
The shipped notes, read where the tarball takes them from.
*/
const packageDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const upgradesDirectory = path.join(packageDirectory, 'upgrades');
const UNRELEASED = 'unreleased.md';

function notesFiles(): string[] {
  return readdirSync(upgradesDirectory).filter((name) => name.endsWith('.md'));
}

function packageJson(): { version: string; files: string[] } {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  expect(parsed).toMatchObject({
    version: expect.any(String),
    files: expect.any(Array),
  });
  return parsed as { version: string; files: string[] };
}

describe('upgrades/: the notes every release ships', () => {
  it.each(notesFiles())('%s parses', (name) => {
    const result = parseUpgradeNotes(
      readFileSync(path.join(upgradesDirectory, name), 'utf8'),
    );
    expect(result).toHaveProperty('notes');
  });

  it.each(notesFiles().filter((name) => name !== UNRELEASED))(
    '%s says the version its name says',
    (name) => {
      const result = parseUpgradeNotes(
        readFileSync(path.join(upgradesDirectory, name), 'utf8'),
      );
      expect(result).toMatchObject({
        notes: { version: name.slice(0, -'.md'.length) },
      });
    },
  );

  it('has notes for the version being released', () => {
    // Cutting a release renames unreleased.md to <version>.md; a cut that
    // forgets fails here rather than shipping a release with nothing to read.
    expect(notesFiles()).toContain(`${packageJson().version}.md`);
  });

  it('keeps an unreleased.md for the next release to collect into', () => {
    expect(notesFiles()).toContain(UNRELEASED);
  });

  it('is in the tarball', () => {
    expect(packageJson().files).toContain('upgrades');
  });
});
