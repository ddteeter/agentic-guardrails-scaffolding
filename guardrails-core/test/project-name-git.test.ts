/**
 * Every worktree of one clone is one project (#236), against real git: the
 * run log's `repo` is the checkout's folder name, which differs per lane, so
 * `stats` needs a name the lanes share.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Exec, spawnExec } from '../src/exec.js';
import { projectName } from '../src/gate-run-log.js';

let directory: string;
let clone: string;

/**
 * Inherited GIT_* variables are stripped: under a git hook they point at the
 * REAL repository, and this test's git calls would read (or write) it.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const exec: Exec = (command, args, options) =>
  spawnExec(command, args, { ...options, env: cleanEnvironment() });

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec('git', args, { cwd });
  expect(result.code, result.stderr).toBe(0);
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'guardrails-project-name-'));
  clone = path.join(directory, 'main-clone');
  mkdirSync(clone);
  await git(clone, 'init', '-q', '-b', 'main');
  await git(clone, 'config', 'user.email', 'test@example.com');
  await git(clone, 'config', 'user.name', 'Test');
  writeFileSync(path.join(clone, 'a.ts'), 'export const a = 1;\n');
  await git(clone, 'add', '-A');
  await git(clone, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('projectName, against real git', () => {
  it('gives a linked worktree the name of the clone it belongs to', async () => {
    const lane = path.join(directory, 'lane-7');
    await git(clone, 'worktree', 'add', '-q', '-b', 'lane', lane);
    await expect(projectName(exec, clone)).resolves.toBe('main-clone');
    await expect(projectName(exec, lane)).resolves.toBe('main-clone');
  });

  it('gives a folder that is not a repository its own name', async () => {
    const loose = path.join(directory, 'loose');
    mkdirSync(loose);
    writeFileSync(path.join(directory, '.git'), 'not a git directory\n');
    await expect(projectName(exec, loose)).resolves.toBe('loose');
  });
});
