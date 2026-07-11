import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runAutofix } from '../src/autofix.js';

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
