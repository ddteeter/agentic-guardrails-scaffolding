/**
 * Reading a repo-relative file as text (#118).
 *
 * Absent and unreadable are one answer -- `undefined` -- because every caller
 * is a hint or a count, and a throw from here escaped the commit gate and hid
 * the violation it was about to report.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoSourceReader } from '../src/repo-source.js';

describe('repoSourceReader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'repo-source-'));
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a file in the repo', () => {
    expect(repoSourceReader(root)('src/a.ts')).toBe('export const a = 1;\n');
  });

  it('reads an absent file as undefined', () => {
    expect(repoSourceReader(root)('src/absent.ts')).toBeUndefined();
  });

  it('reads a directory as undefined instead of throwing EISDIR', () => {
    expect(repoSourceReader(root)('src/lib')).toBeUndefined();
  });

  it('reads a path escaping the repo as undefined', () => {
    // `src` stands in for the repo, so `root/a-outside.ts` is outside it.
    writeFileSync(path.join(root, 'a-outside.ts'), 'x');
    expect(
      repoSourceReader(path.join(root, 'src'))('../a-outside.ts'),
    ).toBeUndefined();
  });
});
