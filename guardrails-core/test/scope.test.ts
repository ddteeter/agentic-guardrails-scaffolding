import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectManifestFiles, isPathAllowed } from '../src/scope.js';
import { stateDirectory, writeViolations } from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let directory: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-scope-'));
  directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function v(file: string): Violation {
  return {
    ruleId: 'x',
    file,
    message: 'm',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

describe('collectManifestFiles', () => {
  it('unions the files across every session manifest', () => {
    writeViolations(directory, 's1', [v('src/a.ts'), v('src/b.ts')]);
    writeViolations(directory, 's2', [v('src/c.ts')]);
    expect(
      [...collectManifestFiles(directory)].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('is empty when there are no manifests', () => {
    expect(collectManifestFiles(directory).size).toBe(0);
  });
});

describe('isPathAllowed', () => {
  const files = new Set(['src/a.ts']);

  it('allows a listed file given as an absolute path', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/a.ts')).toBe(true);
  });

  it('allows a listed file given as a repo-relative path', () => {
    expect(isPathAllowed(files, '/repo', 'src/a.ts')).toBe(true);
  });

  it('denies a file not in the manifest', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/b.ts')).toBe(false);
  });
});
