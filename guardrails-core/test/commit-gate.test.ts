import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runCommitGate } from '../src/gate.js';

function execResult(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

// An Exec that returns a merge-base sha, then a diff for `git diff <sha>`.
function fakeExec(diffForBase: string): Exec {
  return (command, args) => {
    if (args[0] === 'merge-base')
      return Promise.resolve(execResult('BASESHA\n'));
    if (args[0] === 'diff' && args[1] === 'BASESHA')
      return Promise.resolve(execResult(diffForBase));
    return Promise.resolve(execResult(''));
  };
}

const ADDED_DISABLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,1 @@',
  '+// eslint-disable-next-line',
].join('\n');

const SANCTIONED_DISABLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,1 @@',
  '+// Stryker disable all',
].join('\n');

const TWO_IDENTICAL_DISABLES = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,2 @@',
  '+// Stryker disable all',
  '+// Stryker disable all',
].join('\n');

describe('runCommitGate', () => {
  it('flags a suppression introduced on the branch (merge-base diff)', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(ADDED_DISABLE),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('exempts a reviewed suppression listed in sanctionedSuppressions', async () => {
    // The branch introduces a deliberate, human-reviewed mutation exclusion.
    // Without the allowlist this re-flags on EVERY later commit (the commit
    // gate has no per-loop snapshot baseline), wedging the branch.
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(SANCTIONED_DISABLE),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('still flags the same directive in a file the allowlist does not cover', async () => {
    // The key is file-scoped, so a sanction on src/a.ts grants nothing to b.ts.
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(SANCTIONED_DISABLE.replaceAll('src/a.ts', 'src/b.ts')),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
        },
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('blocks a second identical directive once a count-1 grant is spent (headline defect)', async () => {
    // The defect this fix closes: `file|kind|text` carries no occurrence
    // identity, so a single sanction used to exempt EVERY occurrence of the
    // same directive in the file, however many an agent added. A count-1
    // grant must now exempt exactly one occurrence and block the second.
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
          count: 1,
        },
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('exempts exactly as many occurrences as the granted count', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
          count: 2,
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('sums counts across several entries sharing a key into one budget', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'first site',
          count: 1,
        },
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'second site',
          count: 1,
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('is clean when the branch diff has no suppressions', async () => {
    const result = await runCommitGate({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec('+const x = 1;\n'),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });
});

// Same CI-checkout shape as verify: the base branch may exist only as
// `origin/<branch>`. The merge-base must be taken against whichever form
// resolves, or the gate silently audits the wrong range.
function recordingExec(resolvable: readonly string[]): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'rev-parse') {
      const reference = args.at(-1) ?? '';
      return Promise.resolve(
        resolvable.some((candidate) => reference.startsWith(candidate))
          ? execResult('SHA\n')
          : { stdout: '', stderr: 'fatal: bad revision', code: 128 },
      );
    }
    if (args[0] === 'merge-base')
      return Promise.resolve(execResult('BASESHA\n'));
    return Promise.resolve(execResult(''));
  };
  return { exec, calls };
}

describe('commit gate base branch resolution', () => {
  it('takes the merge-base against origin/<branch> when only that resolves', async () => {
    const { exec, calls } = recordingExec(['origin/main']);
    await runCommitGate({ repoRoot: '/repo', baseBranch: 'main', exec });
    expect(calls.find((call) => call[1] === 'merge-base')).toContain(
      'origin/main',
    );
  });

  it('falls back to the configured branch name when nothing resolves', async () => {
    // Paired with the case above: a fallback yielding `undefined` instead of
    // the branch name fails here rather than passing silently.
    const { exec, calls } = recordingExec([]);
    await runCommitGate({ repoRoot: '/repo', baseBranch: 'main', exec });
    expect(calls.find((call) => call[1] === 'merge-base')).toEqual([
      'git',
      'merge-base',
      'main',
      'HEAD',
    ]);
  });
});
