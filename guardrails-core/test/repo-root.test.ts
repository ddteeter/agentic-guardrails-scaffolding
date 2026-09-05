import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { findGitRoot, resolveRepoRoot } from '../src/repo-root.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/**
An `Exec` fake that always resolves to the given result, ignoring its call.
*/
function constantExec(result: ExecResult): Exec {
  return () => Promise.resolve(result);
}

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

/**
An `Exec` fake that records every call it receives.
*/
function recordingExec(result: ExecResult): {
  exec: Exec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    return Promise.resolve(result);
  };
  return { exec, calls };
}

describe('resolveRepoRoot', () => {
  it('returns the git toplevel, not the working directory', async () => {
    const exec = constantExec(ok('/repo\n'));
    await expect(
      resolveRepoRoot(exec, '/repo/packages/api', () => false),
    ).resolves.toBe('/repo');
  });

  it('trims trailing whitespace from git output', async () => {
    const exec = constantExec(ok('/repo\n\n'));
    await expect(resolveRepoRoot(exec, '/repo', () => false)).resolves.toBe(
      '/repo',
    );
  });

  it('asks git from the given working directory', async () => {
    const { exec, calls } = recordingExec(ok('/repo'));
    await resolveRepoRoot(exec, '/repo/sub', () => false);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo/sub',
      },
    ]);
  });

  it('falls back to the working directory when git exits non-zero', async () => {
    // Not a git repo, or git is unavailable. Falling back preserves today's
    // behaviour rather than making every command fail.
    const exec = constantExec({
      stdout: '',
      stderr: 'not a git repository',
      code: 128,
    });
    await expect(
      resolveRepoRoot(exec, '/somewhere', () => false),
    ).resolves.toBe('/somewhere');
  });

  it('falls back to the working directory when git cannot be started', async () => {
    const exec = constantExec({
      stdout: '',
      stderr: 'ENOENT',
      code: 1,
      spawnFailed: true,
    });
    await expect(
      resolveRepoRoot(exec, '/somewhere', () => false),
    ).resolves.toBe('/somewhere');
  });

  it('falls back when git exits zero but prints nothing', async () => {
    const exec = constantExec(ok('   \n'));
    await expect(
      resolveRepoRoot(exec, '/somewhere', () => false),
    ).resolves.toBe('/somewhere');
  });

  it('falls back on a non-zero exit even when git printed something', async () => {
    // The two "falls back on failure" cases above both happen to pair the
    // failure with empty stdout, which lets a mutant that deletes the early
    // return survive by riding the separate empty-stdout fallback. Pairing the
    // failing exit code with non-empty stdout proves the early return itself
    // is load-bearing.
    const exec = constantExec({
      stdout: '/should-be-ignored\n',
      stderr: 'not a git repository',
      code: 128,
    });
    await expect(
      resolveRepoRoot(exec, '/somewhere', () => false),
    ).resolves.toBe('/somewhere');
  });

  it('falls back when spawnFailed is set even if the exit code reads as zero', async () => {
    // Isolates the `spawnFailed === true` check from the `code !== 0` check:
    // code is (implausibly) reported as 0, so only the spawnFailed flag can be
    // driving the fallback.
    const exec = constantExec({
      stdout: '/should-be-ignored\n',
      stderr: 'ENOENT',
      code: 0,
      spawnFailed: true,
    });
    await expect(
      resolveRepoRoot(exec, '/somewhere', () => false),
    ).resolves.toBe('/somewhere');
  });

  it('does not spawn git when a .git is found by walking up', async () => {
    const { exec, calls } = recordingExec(ok('/should-not-be-asked'));
    await expect(
      resolveRepoRoot(
        exec,
        '/repo/packages/api',
        (candidate) => candidate === path.join(path.resolve('/repo'), '.git'),
      ),
    ).resolves.toBe(path.resolve('/repo'));
    expect(calls).toEqual([]);
  });
});

describe('findGitRoot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'guardrails-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks up to a .git directory', () => {
    mkdirSync(path.join(root, '.git'));
    const deep = path.join(root, 'packages', 'web', 'src');
    mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(root);
  });

  it('treats a .git FILE as the root, which is how linked worktrees look', () => {
    // `git worktree add` writes a FILE containing `gitdir: <path>`, not a
    // directory. An existsSync check covers both; a statSync().isDirectory()
    // check would silently skip every worktree.
    writeFileSync(
      path.join(root, '.git'),
      'gitdir: /elsewhere/.git/worktrees/x',
    );
    expect(findGitRoot(root)).toBe(root);
  });

  it('returns undefined when no .git is found anywhere above', () => {
    expect(findGitRoot(root, () => false)).toBeUndefined();
  });

  it('stops at the nearest .git, not the outermost', () => {
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'vendor', 'library');
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(findGitRoot(nested)).toBe(nested);
  });
});
