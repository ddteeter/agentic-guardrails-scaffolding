/**
 * The branch's change set is measured from where it forked, whatever state
 * local `main` is in (#179).
 *
 * The fixture forks `feature` from `origin/main`'s tip, which changed
 * `upstream.ts` after local `main`'s first commit. Local `main` is then put in
 * each of three places:
 *
 * - **behind** the fork point: still at the first commit, as a checkout that
 *   never pulled. A diff against it holds `upstream.ts`, which the branch
 *   inherited and never touched.
 * - **at** the fork point.
 * - **ahead** of it: pulled after the branch forked, with a change to
 *   `ahead.ts`. A diff against it shows `ahead.ts` as modified, by the branch,
 *   which it was not.
 *
 * In all three the gate must see the branch's own files and nothing else:
 * its committed change, an uncommitted edit, and an untracked file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Exec, spawnExec } from '../../src/exec.js';
import { resolveDiffBase } from '../../src/verify/git.js';
import { runVerify } from '../../src/verify/index.js';
import { changedLineRanges } from '../../src/verify/mutate-ranges.js';

let root: string;

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

async function git(...args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd: root });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

function write(file: string, contents: string): void {
  writeFileSync(path.join(root, file), contents);
}

/**
The files the gate's eslint run is handed: the changed-file list.
*/
async function lintedFiles(): Promise<string[]> {
  let linted: string[] = [];
  const recording: Exec = (command, args, options) => {
    if (command === 'eslint') {
      linted = args.filter((argument) => argument.endsWith('.ts'));
      return Promise.resolve({ stdout: '[]', stderr: '', code: 0 });
    }
    return exec(command, args, options);
  };
  await runVerify({
    repoRoot: root,
    baseBranch: 'main',
    exec: recording,
    analyzers: { eslint: 'required', tsc: 'off' },
    resolveBin: (tool) => tool,
  });
  return linted.toSorted((left, right) => left.localeCompare(right));
}

const BRANCH_FILES = ['feature.ts', 'shared.ts', 'untracked.ts'];

let forkPoint: string;
let firstCommit: string;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-diff-base-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  for (const file of ['upstream.ts', 'ahead.ts', 'shared.ts']) {
    write(file, `export const name = '${file}';\n`);
  }
  await git('add', '-A');
  await git('commit', '-q', '-m', 'first');
  firstCommit = await git('rev-parse', 'HEAD');
  write('upstream.ts', `export const name = 'changed upstream';\n`);
  await git('commit', '-q', '-am', 'upstream');
  forkPoint = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/remotes/origin/main', forkPoint);

  await git('checkout', '-q', '-b', 'feature');
  write('feature.ts', `export const name = 'feature';\n`);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'feature');
  write('shared.ts', `export const name = 'edited, not committed';\n`);
  write('untracked.ts', `export const name = 'untracked';\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PLACEMENTS: [string, () => Promise<void>][] = [
  [
    'behind the fork point',
    async () => {
      await git('update-ref', 'refs/heads/main', firstCommit);
    },
  ],
  ['at the fork point', () => Promise.resolve()],
  [
    'ahead of the fork point',
    async () => {
      await git('checkout', '-q', 'main');
      write('ahead.ts', `export const name = 'pulled after the fork';\n`);
      await git('commit', '-q', '-am', 'ahead');
      await git('checkout', '-q', 'feature');
      write('shared.ts', `export const name = 'edited, not committed';\n`);
      write('untracked.ts', `export const name = 'untracked';\n`);
    },
  ],
];

describe.each(PLACEMENTS)('with local main %s', (_label, place) => {
  beforeEach(place);

  it('resolves the diff base to the fork point', async () => {
    expect(await resolveDiffBase(exec, root, 'main')).toEqual({
      ref: forkPoint,
    });
  });

  it('hands the gate only the branch’s own files', async () => {
    expect(await lintedFiles()).toEqual(BRANCH_FILES);
  });

  // `feature.ts` is new since the fork, so it has no ranges: a new file is
  // mutated whole.
  it('plans line ranges for only the branch’s own edits', async () => {
    const ranges = await changedLineRanges(exec, root, { baseBranch: 'main' });
    expect(
      ranges
        .keys()
        .toArray()
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['shared.ts']);
  });
});

describe('resolveDiffBase without an origin ref', () => {
  it('measures from local main alone', async () => {
    await git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(await resolveDiffBase(exec, root, 'main')).toEqual({
      ref: forkPoint,
    });
  });
});
