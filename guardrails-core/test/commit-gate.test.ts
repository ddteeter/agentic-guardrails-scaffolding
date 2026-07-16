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
