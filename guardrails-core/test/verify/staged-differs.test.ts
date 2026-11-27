/**
 * The commit rung judges what is on disk, and commits what is in the index.
 *
 * The staged file list comes from the index; every analyzer then reads the
 * file from the working tree. A staged file that also has unstaged changes
 * (partial staging, or an edit made while the gate was running) is therefore
 * judged on content the commit does not hold. Found on the Swift-pack lane:
 * a staged clone pair passed the commit gate because the working copy had
 * been edited meanwhile. `runVerify` refuses such a file instead.
 */

import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import type { StackPack } from '../../src/packs/pack.js';
import { type Analyzer, runVerify } from '../../src/verify/index.js';

const ok: ExecResult = { stdout: '', stderr: '', code: 0 };

function nothing(): undefined {
  return;
}

function isNever(): boolean {
  return false;
}

function done(): Promise<void> {
  return Promise.resolve();
}

function nobody(): () => undefined {
  return nothing;
}

function echo(provider: string): string {
  return provider;
}

/**
A pack with one changed-files analyzer that records each run and its files.
*/
function recordingPack(runs: string[][]): StackPack<Analyzer> {
  return {
    id: 'typescript',
    isSourceFile: (file) => file.endsWith('.ts'),
    isTestFile: isNever,
    isConfigFile: isNever,
    analyzers: [
      {
        tool: 'lint',
        provider: 'lint',
        minRung: 'stop',
        scope: 'changed-files',
        run: (_options, _resolveBin, files) => {
          runs.push(files);
          return Promise.resolve([]);
        },
      },
    ],
    isProviderDeclared: isNever,
    installHint: echo,
    autofix: done,
    ownerOf: nobody,
    coveringTests: nobody,
  };
}

interface Git {
  /**
  What `git diff --cached --name-only` lists.
  */
  staged: readonly string[];
  /**
   * What each successive `git ls-files --modified` answers: the first before
   * the analyzers run, the second after.
   */
  modified: readonly (readonly string[] | ExecResult)[];
}

function gitExec(git: Git): {
  exec: Exec;
  calls: string[];
  askedFrom: (string | undefined)[];
} {
  const calls: string[] = [];
  const askedFrom: (string | undefined)[] = [];
  let asked = 0;
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (line === 'git ls-files --modified') {
      askedFrom.push(options?.cwd);
      const answer = git.modified[asked] ?? [];
      asked += 1;
      return Promise.resolve(
        Array.isArray(answer)
          ? { ...ok, stdout: `${answer.join('\n')}\n` }
          : (answer as ExecResult),
      );
    }
    return Promise.resolve(
      args.includes('--cached')
        ? { ...ok, stdout: `${git.staged.join('\n')}\n` }
        : ok,
    );
  };
  return { exec, calls, askedFrom };
}

async function verify(
  git: Git,
  changedScope: 'staged' | 'branch' = 'staged',
): Promise<{
  rules: string[];
  messages: string[];
  files: string[];
  runs: string[][];
  calls: string[];
  askedFrom: (string | undefined)[];
}> {
  const runs: string[][] = [];
  const { exec, calls, askedFrom } = gitExec(git);
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    changedScope,
    profile: 'commit',
    readSource: nothing,
    declaredProviders: new Set<string>(),
    packs: [recordingPack(runs)],
  });
  return {
    rules: violations.map((violation) => violation.ruleId),
    messages: violations.map((violation) => violation.message),
    files: violations.map((violation) => violation.file),
    runs,
    calls,
    askedFrom,
  };
}

const MESSAGE =
  'src/a.ts is staged, and the file on disk has changes that are not ' +
  'staged. The gate reads files from disk, so it would be judging content ' +
  'this commit does not hold. Stage the rest (`git add src/a.ts`) or set ' +
  'it aside (`git stash --keep-index`), then commit again.';

describe('a staged file that differs on disk', () => {
  it('is refused, by name, before any analyzer runs', async () => {
    const result = await verify({
      staged: ['src/a.ts', 'src/b.ts'],
      modified: [['src/a.ts']],
    });
    expect(result.rules).toEqual(['guardrails/staged-differs']);
    expect(result.files).toEqual(['src/a.ts']);
    expect(result.messages).toEqual([MESSAGE]);
    expect(result.runs).toEqual([]);
  });

  it('is an error, which nobody but the committer can resolve', async () => {
    const { exec } = gitExec({
      staged: ['src/a.ts'],
      modified: [['src/a.ts']],
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      changedScope: 'staged',
      profile: 'commit',
      readSource: nothing,
      declaredProviders: new Set<string>(),
      packs: [recordingPack([])],
    });
    expect(violations).toEqual([
      {
        ruleId: 'guardrails/staged-differs',
        file: 'src/a.ts',
        message: MESSAGE,
        severity: 'error',
        fixable: false,
        tool: 'guardrails',
      },
    ]);
  });

  it('names every such file, whatever its type', async () => {
    const result = await verify({
      staged: ['src/a.ts', 'README.md', 'src/b.ts'],
      modified: [['README.md', 'src/b.ts']],
    });
    expect(result.files).toEqual(['README.md', 'src/b.ts']);
  });

  it('leaves a file alone that is edited on disk but not staged', async () => {
    const result = await verify({
      staged: ['src/a.ts'],
      modified: [['src/other.ts'], ['src/other.ts']],
    });
    expect(result.rules).toEqual([]);
    expect(result.runs).toEqual([['src/a.ts']]);
  });

  it('is caught when the edit lands while the analyzers run', async () => {
    const result = await verify({
      staged: ['src/a.ts'],
      modified: [[], ['src/a.ts']],
    });
    // The analyzers ran, on content that then changed under them.
    expect(result.runs).toEqual([['src/a.ts']]);
    expect(result.rules).toEqual(['guardrails/staged-differs']);
    expect(result.messages).toEqual([MESSAGE]);
  });

  it('asks git twice at the commit rung: before the analyzers and after', async () => {
    const { calls } = await verify({
      staged: ['src/a.ts'],
      modified: [[], []],
    });
    expect(
      calls.filter((call) => call === 'git ls-files --modified'),
    ).toHaveLength(2);
    expect(calls.indexOf('git ls-files --modified')).toBeGreaterThan(
      calls.indexOf('git diff --cached --name-only --diff-filter=ACM'),
    );
  });

  it('asks git from the repository root, both times', async () => {
    const { askedFrom } = await verify({
      staged: ['src/a.ts'],
      modified: [[], []],
    });
    expect(askedFrom).toEqual(['/repo', '/repo']);
  });

  it('asks once when the first answer already refuses the commit', async () => {
    const { calls } = await verify({
      staged: ['src/a.ts'],
      modified: [['src/a.ts'], ['src/a.ts']],
    });
    expect(
      calls.filter((call) => call === 'git ls-files --modified'),
    ).toHaveLength(1);
  });

  it('is not asked about when nothing is staged', async () => {
    const result = await verify({ staged: [], modified: [['src/a.ts']] });
    expect(result.calls).not.toContain('git ls-files --modified');
    expect(result.rules).toEqual([]);
  });

  it('is not asked about at the push and ci rungs, which judge the branch', async () => {
    const result = await verify(
      { staged: ['src/a.ts'], modified: [['src/a.ts']] },
      'branch',
    );
    expect(result.calls).not.toContain('git ls-files --modified');
    expect(result.rules).not.toContain('guardrails/staged-differs');
  });

  it('fails the gate when git cannot answer, rather than assuming no difference', async () => {
    const result = await verify({
      staged: ['src/a.ts'],
      modified: [{ ...ok, code: 128, stderr: 'fatal: index file corrupt' }],
    });
    expect(result.rules).toEqual(['guardrails/analyzer-failed']);
    expect(result.runs).toEqual([]);
  });

  it('fails the gate when git is killed while answering', async () => {
    const result = await verify({
      staged: ['src/a.ts'],
      modified: [{ ...ok, signal: 'SIGKILL' }],
    });
    expect(result.rules).toEqual(['guardrails/analyzer-failed']);
  });

  it('fails the gate when git cannot answer after the analyzers either', async () => {
    const result = await verify({
      staged: ['src/a.ts'],
      modified: [[], { ...ok, code: 128, stderr: 'fatal: index file corrupt' }],
    });
    expect(result.runs).toEqual([['src/a.ts']]);
    expect(result.rules).toEqual(['guardrails/analyzer-failed']);
  });
});
