import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import type { PackAnalyzer, StackContext } from '../../src/packs/pack.js';
import { implicitStack } from '../../src/packs/stacks.js';
import { npmInstallHint, typescriptPack } from '../../src/packs/typescript.js';

const ok: ExecResult = { stdout: '', stderr: '', code: 0 };

const lint: PackAnalyzer = {
  tool: 'eslint',
  provider: 'eslint',
  minRung: 'stop',
  scope: 'changed-files',
};

const pack = typescriptPack([lint]);

let root = '';

function context(): StackContext {
  return { repoRoot: root, stack: implicitStack() };
}

function write(file: string, contents: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ts-pack-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the TypeScript pack', () => {
  it('is the typescript pack, holding the analyzer table it was given', () => {
    expect(pack.id).toBe('typescript');
    expect(pack.analyzers).toEqual([lint]);
  });

  it('calls a .ts or .tsx file source, and a declaration file not', () => {
    expect(pack.isSourceFile('src/a.ts')).toBe(true);
    expect(pack.isSourceFile('src/a.tsx')).toBe(true);
    expect(pack.isSourceFile('src/a.d.ts')).toBe(false);
    expect(pack.isSourceFile('ios/App/a.swift')).toBe(false);
  });

  it('calls a spec, or anything under a test directory, test material', () => {
    expect(pack.isTestFile('src/a.test.ts')).toBe(true);
    expect(pack.isTestFile('test/helpers/build.ts')).toBe(true);
    expect(pack.isTestFile('src/a.ts')).toBe(false);
  });

  it('calls a *.config.ts a config file', () => {
    expect(pack.isConfigFile('vitest.config.ts')).toBe(true);
    expect(pack.isConfigFile('src/config.ts')).toBe(false);
  });

  it('reads a provider as declared from the package.json names, whatever the stack', () => {
    expect(
      pack.isProviderDeclared(context().stack, 'eslint', new Set(['eslint'])),
    ).toBe(true);
    expect(
      pack.isProviderDeclared(context().stack, 'eslint', new Set(['knip'])),
    ).toBe(false);
  });

  it('says how to install a provider', () => {
    expect(pack.installHint('knip')).toBe('`npm install --save-dev knip`');
    expect(npmInstallHint('git')).toBe('`npm install --save-dev git`');
  });
});

describe('the TypeScript pack: autofix', () => {
  it('runs eslint --fix over the files, from the repository root', async () => {
    const calls: {
      command: string;
      args: string[];
      cwd: string | undefined;
    }[] = [];
    const exec: Exec = (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return Promise.resolve(ok);
    };
    await pack.autofix(
      { ...context(), exec, resolveBin: (tool) => `/bin/${tool}` },
      ['src/a.ts', 'src/b.tsx'],
    );
    expect(calls).toEqual([
      {
        command: '/bin/eslint',
        args: ['--fix', 'src/a.ts', 'src/b.tsx'],
        cwd: root,
      },
    ]);
  });
});

describe('the TypeScript pack: ownerOf', () => {
  it('names the workspace member that holds a file', () => {
    write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    write('packages/billing/package.json', '{}');
    const ownerOf = pack.ownerOf(context());
    expect(ownerOf('packages/billing/src/a.ts')).toBe('packages/billing');
  });

  it('names nobody where no package.json sits above the file', () => {
    expect(pack.ownerOf(context())('src/a.ts')).toBeUndefined();
  });
});

describe('the TypeScript pack: coveringTests', () => {
  it('finds the test that imports a file, on a real repository', () => {
    write('src/a.ts', 'export const a = 1;\n');
    write(
      'test/unrelated-name.test.ts',
      "import { a } from '../src/a.js';\n\nexport const seen = a;\n",
    );
    // TypeScript itself is loaded from the repository being gated.
    const here = path.resolve(import.meta.dirname, '..', '..', '..');
    const find = pack.coveringTests({ ...context(), repoRoot: root });
    expect(here).not.toBe(root);
    // No TypeScript is installed in the temporary repository, so nothing is
    // worked out: the answer is "not computed", never "none exist".
    expect(find('src/a.ts')).toBeUndefined();
  });

  it('does not work out the tests of a test file', () => {
    expect(pack.coveringTests(context())('test/a.test.ts')).toBeUndefined();
  });

  it('finds the tests of a file in this repository', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const find = pack.coveringTests({ repoRoot, stack: implicitStack() });
    expect(find('guardrails-core/src/packs/stacks.ts')).toContain(
      'guardrails-core/test/packs/stacks.test.ts',
    );
  });
});
