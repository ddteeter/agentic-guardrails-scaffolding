import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { runVerify } from '../../src/verify/index.js';

const eslintJson = JSON.stringify([
  {
    filePath: '/repo/src/foo.ts',
    messages: [
      {
        ruleId: 'no-console',
        severity: 2,
        message: 'Unexpected console statement.',
        line: 4,
        column: 3,
      },
    ],
  },
]);

const tscOut = "src/new.ts(2,1): error TS2304: Cannot find name 'oops'.";

const knipJson = JSON.stringify({
  issues: [
    {
      file: 'src/dead.ts',
      files: [{ name: 'src/dead.ts' }],
      exports: [],
      types: [],
      dependencies: [],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
  ],
});

interface Call {
  command: string;
  args: string[];
}

/** A fake exec that records calls and dispatches canned output by command. */
function fakeExec(overrides: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
  const exec: Exec = (command, args) => {
    calls.push({ command, args });
    const key = [command, ...args].join(' ');
    if (overrides[key]) {
      return Promise.resolve(overrides[key]);
    }
    if (args.includes('--name-only')) {
      return Promise.resolve(ok('src/foo.ts\nREADME.md'));
    }
    if (args.includes('--others')) {
      return Promise.resolve(ok('src/new.ts'));
    }
    if (command === 'eslint' || args.includes('eslint')) {
      return Promise.resolve(ok(eslintJson));
    }
    if (command === 'tsc' || args.includes('tsc')) {
      return Promise.resolve(ok(tscOut));
    }
    if (command === 'knip' || args.includes('knip')) {
      return Promise.resolve(ok(knipJson));
    }
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

describe('runVerify', () => {
  it('aggregates eslint and tsc violations for changed TS files', async () => {
    const { exec } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    const ids = violations.map((v) => v.ruleId);
    expect(ids).toContain('no-console');
    expect(ids).toContain('TS2304');
    expect(violations.find((v) => v.tool === 'tsc')?.file).toBe('src/new.ts');
  });

  it('only lints TypeScript files (skips README.md)', async () => {
    const { exec, calls } = fakeExec();
    await runVerify({ repoRoot: '/repo', baseBranch: 'main', exec });
    const eslintCall = calls.find(
      (c) => c.command === 'eslint' || c.args.includes('eslint'),
    );
    expect(eslintCall?.args).toContain('src/foo.ts');
    expect(eslintCall?.args).toContain('src/new.ts');
    expect(eslintCall?.args).not.toContain('README.md');
  });

  it('short-circuits to clean when no TS files changed', async () => {
    const noTs = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md\ndocs/guide.md',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: noTs.exec,
    });
    expect(violations).toEqual([]);
    // Neither linter should have run.
    expect(
      noTs.calls.some((c) => c.command === 'eslint' || c.command === 'tsc'),
    ).toBe(false);
  });

  it('runs knip and includes its violations at the commit profile', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
    });
    expect(violations.map((v) => v.ruleId)).toContain('knip/files');
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(true);
  });

  it('does NOT run knip at the stop profile (default)', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec, // no profile → defaults to 'stop'
    });
    expect(violations.map((v) => v.ruleId)).not.toContain('knip/files');
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(false);
  });

  it('runs knip at the ci profile', async () => {
    const { exec, calls } = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'ci',
    });
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(true);
  });
});
