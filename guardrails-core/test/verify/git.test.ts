import { describe, expect, it } from 'vitest';

import {
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
