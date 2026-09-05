import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadWorkspaceResolver, withPackages } from '../src/workspaces.js';
import type { Violation } from '../src/violation.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-ws-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
Create `<root>/<relative>/package.json`.
*/
function makePackage(relative: string): void {
  const directory = path.join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), '{}');
}

function makeRoot(contents: string): void {
  writeFileSync(path.join(root, 'package.json'), contents);
}

describe('loadWorkspaceResolver — declared mode', () => {
  it('attributes a file to its declared workspace member', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    makePackage('packages/api');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/src/a.ts')).toBe('packages/api');
  });

  it('ignores a nested package.json that is not a declared member', () => {
    // The case this repo actually has: a test fixture with its own manifest.
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    makePackage('packages/api');
    makePackage('packages/api/test/fixture');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/test/fixture/x.ts')).toBe('packages/api');
  });

  it('accepts yarn’s object form', () => {
    makeRoot(JSON.stringify({ workspaces: { packages: ['apps/*'] } }));
    makePackage('apps/web');
    expect(loadWorkspaceResolver(root)('apps/web/src/a.ts')).toBe('apps/web');
  });

  it('honours a ! exclusion', () => {
    makeRoot(
      JSON.stringify({ workspaces: ['packages/*', '!packages/private'] }),
    );
    makePackage('packages/api');
    makePackage('packages/private');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/a.ts')).toBe('packages/api');
    expect(resolve('packages/private/a.ts')).toBeUndefined();
  });

  it('requires a matching directory to actually contain a package.json', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(path.join(root, 'packages/not-a-package'), { recursive: true });
    expect(
      loadWorkspaceResolver(root)('packages/not-a-package/a.ts'),
    ).toBeUndefined();
  });

  it('picks the DEEPEST match when packages nest', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*', 'packages/*/sub'] }));
    makePackage('packages/api');
    makePackage('packages/api/sub');
    expect(loadWorkspaceResolver(root)('packages/api/sub/a.ts')).toBe(
      'packages/api/sub',
    );
  });

  it('falls back when a declared glob uses unsupported syntax', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/{a,b}'] }));
    makePackage('packages/a');
    // The glob is declined, but nearest-ancestor still attributes the file.
    expect(loadWorkspaceResolver(root)('packages/a/x.ts')).toBe('packages/a');
  });

  it('gates yarn’s object form on the declared pattern, not merely on proximity', () => {
    // Both modes would attribute the file to `packages/api` here if the object
    // form's patterns were silently dropped instead of applied — the nested
    // fixture manifest would then win fallback mode's nearest-ancestor search.
    // Declaring an unmatched nested member proves the object-form glob is the
    // thing doing the gating.
    makeRoot(JSON.stringify({ workspaces: { packages: ['packages/*'] } }));
    makePackage('packages/api');
    makePackage('packages/api/test/fixture');
    const resolve = loadWorkspaceResolver(root);
    expect(resolve('packages/api/test/fixture/x.ts')).toBe('packages/api');
  });

  it('skips a non-string entry in the workspaces array without crashing', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*', 42] }));
    makePackage('packages/api');
    expect(loadWorkspaceResolver(root)('packages/api/a.ts')).toBe(
      'packages/api',
    );
  });
});

describe('loadWorkspaceResolver — fallback mode', () => {
  it('uses the nearest ancestor package.json when nothing is declared', () => {
    makeRoot('{}');
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/src/a.ts')).toBe(
      'libs/thing',
    );
  });

  it('falls back when the root package.json is malformed', () => {
    makeRoot('{ not json');
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/a.ts')).toBe('libs/thing');
  });

  it('falls back when there is no root package.json at all', () => {
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/a.ts')).toBe('libs/thing');
  });

  it('falls back when the root package.json parses to a non-object value', () => {
    makeRoot('null');
    makePackage('libs/thing');
    expect(loadWorkspaceResolver(root)('libs/thing/a.ts')).toBe('libs/thing');
  });
});

describe('loadWorkspaceResolver — no owning package', () => {
  it('returns undefined for a root-owned file', () => {
    makeRoot(JSON.stringify({ workspaces: ['packages/*'] }));
    expect(loadWorkspaceResolver(root)('scripts/build.ts')).toBeUndefined();
  });

  it('returns undefined for a path escaping the repo root', () => {
    makeRoot('{}');
    expect(loadWorkspaceResolver(root)('../elsewhere/a.ts')).toBeUndefined();
  });

  it('never throws on a nonexistent repo root', () => {
    const resolve = loadWorkspaceResolver(path.join(root, 'missing'));
    expect(resolve('a/b.ts')).toBeUndefined();
  });

  it('stops at the repo root even when a real package.json sits just outside it', () => {
    // Places an actual package.json exactly where an unguarded upward walk
    // would land, so a broken escape guard would return a wrong package
    // instead of merely returning undefined for the wrong reason.
    const repoRoot = path.join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(path.join(repoRoot, 'package.json'), '{}');
    mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
    writeFileSync(path.join(root, 'elsewhere', 'package.json'), '{}');
    expect(
      loadWorkspaceResolver(repoRoot)('../elsewhere/a.ts'),
    ).toBeUndefined();
  });
});

function violation(file: string, extra: Partial<Violation> = {}): Violation {
  return {
    ruleId: 'no-console',
    file,
    message: 'msg',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
    ...extra,
  };
}

function resolvePackage(file: string): string | undefined {
  return file.startsWith('packages/api/') ? 'packages/api' : undefined;
}

describe('withPackages', () => {
  it("sets package from the violation's file", () => {
    const [tagged] = withPackages(
      [violation('packages/api/src/a.ts')],
      resolvePackage,
    );
    expect(tagged?.package).toBe('packages/api');
  });

  it('adds no key when there is no owning package', () => {
    const [untagged] = withPackages(
      [violation('scripts/build.ts')],
      resolvePackage,
    );
    expect(untagged && Object.hasOwn(untagged, 'package')).toBe(false);
  });

  it('does not overwrite a package a producer already set', () => {
    const [tagged] = withPackages(
      [violation('packages/api/src/a.ts', { package: 'explicit' })],
      resolvePackage,
    );
    expect(tagged?.package).toBe('explicit');
  });

  it('is idempotent, so it is safe to apply more than once', () => {
    const once = withPackages([violation('packages/api/a.ts')], resolvePackage);
    expect(withPackages(once, resolvePackage)).toEqual(once);
  });

  it('preserves order and every other field', () => {
    const input = [violation('scripts/b.ts'), violation('packages/api/a.ts')];
    const result = withPackages(input, resolvePackage);
    expect(result.map((entry) => entry.file)).toEqual([
      'scripts/b.ts',
      'packages/api/a.ts',
    ]);
    expect(result[0]).toEqual(input[0]);
  });

  it('is empty for no violations', () => {
    expect(withPackages([], resolvePackage)).toEqual([]);
  });
});
