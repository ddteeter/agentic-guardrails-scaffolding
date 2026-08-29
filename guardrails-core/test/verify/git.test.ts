import { describe, expect, it } from 'vitest';

import {
  isTestFile,
  isTypeScriptFile,
  mergeChangedFiles,
  parseFileList,
} from '../../src/verify/git.js';

describe('parseFileList', () => {
  it('splits, trims, and drops blank lines', () => {
    expect(parseFileList('src/a.ts\nsrc/b.ts\n\n')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseFileList('')).toEqual([]);
  });
});

describe('mergeChangedFiles', () => {
  it('unions tracked-diff and untracked files, de-duplicating', () => {
    const merged = mergeChangedFiles(
      'src/a.ts\nsrc/b.ts',
      'src/b.ts\nsrc/c.ts',
    );
    expect(merged.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('de-duplicates across a stray leading ./ prefix', () => {
    expect(mergeChangedFiles('./src/a.ts', 'src/a.ts')).toEqual(['src/a.ts']);
  });
});

describe('isTypeScriptFile', () => {
  it('accepts .ts and .tsx', () => {
    expect(isTypeScriptFile('src/a.ts')).toBe(true);
    expect(isTypeScriptFile('src/a.tsx')).toBe(true);
  });

  it('rejects declaration files and non-TS files', () => {
    expect(isTypeScriptFile('src/a.d.ts')).toBe(false);
    expect(isTypeScriptFile('README.md')).toBe(false);
    expect(isTypeScriptFile('src/a.js')).toBe(false);
  });
});

describe('isTestFile', () => {
  it('flags test and spec files, not production sources', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(isTestFile('test/bar.test.ts')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
    expect(isTestFile('src/testing.ts')).toBe(false);
  });
});

describe('git helpers mutation-hardening', () => {
  it('trims each entry and strips only a leading ./', () => {
    // Kills the dropped `.trim().replace()` chain: without it the padded entry
    // keeps its spaces and the whitespace-only line survives the length filter.
    expect(parseFileList('  src/a.ts  \n   \n./src/b.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    // Kills the `^` anchor mutant: unanchored, this would rewrite the interior
    // `./` segment into `docs/guide.md`.
    expect(parseFileList('docs/./guide.md')).toEqual(['docs/./guide.md']);
  });

  it('anchors the TypeScript extension at end-of-name', () => {
    // Kills the `$` anchor mutants: unanchored, a suffixed backup file matches.
    expect(isTypeScriptFile('src/a.ts.bak')).toBe(false);
    expect(isTestFile('src/a.test.ts.bak')).toBe(false);
  });
});
