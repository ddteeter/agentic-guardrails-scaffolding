import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runAutofix } from '../src/autofix.js';
import type { StackConfig, StackPack } from '../src/packs/pack.js';

const ok: ExecResult = { stdout: '', stderr: '', code: 0 };

interface Call {
  command: string;
  args: string[];
}

function recordingExec(): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(ok);
  };
  return { exec, calls };
}

describe('runAutofix', () => {
  it('runs eslint --fix only on changed TypeScript files', async () => {
    const { exec, calls } = recordingExec();
    await runAutofix({
      repoRoot: '/repo',
      files: ['src/a.ts', 'README.md', 'src/b.tsx', 'src/c.d.ts'],
      exec,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--fix');
    expect(calls[0]?.args).toContain('src/a.ts');
    expect(calls[0]?.args).toContain('src/b.tsx');
    expect(calls[0]?.args).not.toContain('README.md');
    expect(calls[0]?.args).not.toContain('src/c.d.ts');
  });

  it('does nothing when no TypeScript files changed', async () => {
    const { exec, calls } = recordingExec();
    await runAutofix({ repoRoot: '/repo', files: ['README.md'], exec });
    expect(calls).toHaveLength(0);
  });

  it('runs the bare eslint command when no resolver is given', async () => {
    const { exec, calls } = recordingExec();
    await runAutofix({ repoRoot: '/repo', files: ['src/a.ts'], exec });
    expect(calls[0]?.command).toBe('eslint');
  });

  it('resolves the eslint binary through resolveBin when provided', async () => {
    const { exec, calls } = recordingExec();
    await runAutofix({
      repoRoot: '/repo',
      files: ['src/a.ts'],
      exec,
      resolveBin: (tool) => `/repo/node_modules/.bin/${tool}`,
    });
    expect(calls[0]?.command).toBe('/repo/node_modules/.bin/eslint');
  });
});

function isNever(): boolean {
  return false;
}

function nothing(): undefined {
  return;
}

function nobody(): () => undefined {
  return nothing;
}

function echo(provider: string): string {
  return provider;
}

function fixerPack(
  id: StackPack['id'],
  extension: string,
  fixed: [string, string, string[]][],
): StackPack {
  return {
    id,
    isSourceFile: (file) => file.endsWith(extension),
    isTestFile: isNever,
    isConfigFile: isNever,
    analyzers: [],
    isProviderDeclared: isNever,
    installHint: echo,
    autofix: (run, files) => {
      fixed.push([id, run.stack.root, files]);
      return Promise.resolve();
    },
    ownerOf: nobody,
    coveringTests: nobody,
  };
}

describe('runAutofix across stacks', () => {
  const web: StackConfig = {
    pack: 'typescript',
    root: '.',
    exclude: ['ios/**'],
    wholeProjectTrigger: 'always',
    debugTargets: [],
  };
  const ios: StackConfig = {
    pack: 'swift',
    root: 'ios',
    exclude: [],
    wholeProjectTrigger: 'stack-changes',
    debugTargets: [],
  };

  async function fix(
    files: string[],
    stacks: readonly StackConfig[],
    ids: readonly StackPack['id'][] = ['typescript', 'swift'],
  ): Promise<[string, string, string[]][]> {
    const fixed: [string, string, string[]][] = [];
    const { exec } = recordingExec();
    await runAutofix({
      repoRoot: '/repo',
      files,
      exec,
      stacks,
      packs: ids.map((id) =>
        fixerPack(id, id === 'swift' ? '.swift' : '.ts', fixed),
      ),
    });
    return fixed;
  }

  it('hands each file to the pack of the stack that owns it', async () => {
    expect(
      await fix(['src/a.ts', 'ios/App/a.swift', 'ios/App/b.swift'], [web, ios]),
    ).toEqual([
      ['typescript', '.', ['src/a.ts']],
      ['swift', 'ios', ['ios/App/a.swift', 'ios/App/b.swift']],
    ]);
  });

  it('places an absolute path by where it sits in the repository', async () => {
    expect(
      await fix(['/repo/ios/App/a.swift', '/repo/src/a.ts'], [web, ios]),
    ).toEqual([
      ['typescript', '.', ['/repo/src/a.ts']],
      ['swift', 'ios', ['/repo/ios/App/a.swift']],
    ]);
  });

  it('fixes nothing a stack does not own, or its pack does not call source', async () => {
    // A .ts file under ios/: the web stack excludes it and Swift does not
    // format TypeScript. A .swift file outside ios/: no Swift stack owns it.
    expect(
      await fix(['ios/Tools/build.ts', 'src/stray.swift'], [web, ios]),
    ).toEqual([]);
  });

  it('skips a stack whose pack this version does not have', async () => {
    expect(
      await fix(['src/a.ts', 'ios/App/a.swift'], [web, ios], ['typescript']),
    ).toEqual([['typescript', '.', ['src/a.ts']]]);
  });

  it('calls no fixer for a stack with nothing to fix', async () => {
    expect(await fix(['README.md'], [web, ios])).toEqual([]);
  });
});
