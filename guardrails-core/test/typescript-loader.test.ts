/**
 * The consumer's own `typescript`, loaded for parsing (#196) — the same
 * optional peer the import graph resolves with (#120).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTypescriptParser } from '../src/typescript-loader.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ts-loader-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadTypescriptParser', () => {
  it('is undefined for a repo with no typescript installed', () => {
    const ancestors = [root];
    for (
      let parent = path.dirname(root);
      parent !== ancestors.at(-1);
      parent = path.dirname(parent)
    ) {
      ancestors.push(parent);
    }
    expect(
      ancestors.filter((directory) =>
        existsSync(path.join(directory, 'node_modules', 'typescript')),
      ),
    ).toEqual([]);
    expect(loadTypescriptParser(root)).toBeUndefined();
  });

  it('loads the typescript of the repo it is given', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    expect(loadTypescriptParser(repoRoot)?.createSourceFile).toBe(
      ts.createSourceFile,
    );
  });

  it('is undefined when loading throws', () => {
    expect(
      loadTypescriptParser(root, () => {
        throw new Error('Cannot find module typescript');
      }),
    ).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a scanner with no parser', { preProcessFile: () => 0 }],
  ])('is undefined for %s', (_name, candidate) => {
    expect(loadTypescriptParser(root, () => candidate)).toBeUndefined();
  });

  it('is what it loaded when that has a parser', () => {
    expect(loadTypescriptParser(root, () => ts)).toBe(ts);
  });
});
