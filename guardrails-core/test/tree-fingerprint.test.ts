import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Exec, type ExecResult, spawnExec } from '../src/exec.js';
import { packageVersion } from '../src/package-root.js';
import { treeFingerprint } from '../src/tree-fingerprint.js';

/**
 * A trap for any git call that INHERITS this worker's environment.
 *
 * `treeFingerprint` runs `git add -A`, and a stryker mutant that drops the
 * call's options object leaves git with no `cwd` and no `env`: it then runs
 * from the stryker sandbox, which sits INSIDE this repository, discovers the
 * real `.git`, and stages the whole working tree into the real index. That
 * happened while this module was being written. With `GIT_DIR` pointing
 * nowhere, such a call fails instead, which also kills the mutant. Every
 * legitimate call strips `GIT_*` (the code under test and `git()` below both
 * do), so the trap never reaches them.
 */
process.env.GIT_DIR = path.join(tmpdir(), 'guardrails-no-such-git-dir');

let root: string;

/**
 * The environment every git call in these tests runs under. Inherited GIT_*
 * variables are stripped: under a git hook (this suite runs at pre-push) they
 * point at the REAL repository, and a test's `git add` would land there.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

async function git(...args: string[]): Promise<string> {
  const result = await spawnExec('git', args, {
    cwd: root,
    env: cleanEnvironment(),
  });
  return result.stdout.trim();
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-fingerprint-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fingerprint(): Promise<string | undefined> {
  return treeFingerprint(spawnExec, root, 'main');
}

describe('treeFingerprint', () => {
  it('is stable while nothing changes', async () => {
    const first = await fingerprint();
    expect(first).toBeDefined();
    expect(await fingerprint()).toBe(first);
  });

  it('changes when a tracked file is edited', async () => {
    const before = await fingerprint();
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
    expect(await fingerprint()).not.toBe(before);
  });

  it('changes when an untracked file appears', async () => {
    // The stop gate verifies untracked files too, so a new one must count.
    const before = await fingerprint();
    writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
    expect(await fingerprint()).not.toBe(before);
  });

  it('ignores what .gitignore ignores', async () => {
    const before = await fingerprint();
    mkdirSync(path.join(root, 'ignored'));
    writeFileSync(path.join(root, 'ignored', 'x.ts'), 'junk\n');
    expect(await fingerprint()).toBe(before);
  });

  it('leaves the real index untouched', async () => {
    writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
    await fingerprint();
    expect(await git('diff', '--cached', '--name-only')).toBe('');
    expect(await git('status', '--porcelain')).toContain('?? b.ts');
  });

  it('is undefined outside a git repository', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'guardrails-not-git-'));
    try {
      expect(
        await treeFingerprint(spawnExec, elsewhere, 'main'),
      ).toBeUndefined();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

interface Call {
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * An Exec that answers each git subcommand from `answers` (by its first
 * argument) and records every call. `onCall` runs before the answer, for the
 * cases that need to observe the filesystem mid-flight.
 */
function scripted(
  answers: Partial<Record<string, ExecResult>>,
  calls: Call[],
  onCall?: (call: Call) => void,
): Exec {
  return (_command, args, options) => {
    const call = { args, cwd: options?.cwd, env: options?.env };
    calls.push(call);
    onCall?.(call);
    const [subcommand = ''] = args;
    return Promise.resolve(
      answers[subcommand] ?? { stdout: '', stderr: '', code: 0 },
    );
  };
}

const answered = (stdout: string, code = 0): ExecResult => ({
  stdout,
  stderr: '',
  code,
});

const HEALTHY: Partial<Record<string, ExecResult>> = {
  'rev-parse': answered('.git/index\n'),
  add: answered(''),
  'write-tree': answered('abc\n'),
  'merge-base': answered('basesha\n'),
};

describe('treeFingerprint — the git conversation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strips inherited GIT_* variables and points git at a private index', async () => {
    vi.stubEnv('GIT_SENTINEL_X', '1');
    vi.stubEnv('GUARDRAILS_SENTINEL', '1');
    const calls: Call[] = [];

    await treeFingerprint(scripted(HEALTHY, calls), root, 'main');

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.env?.GUARDRAILS_SENTINEL).toBe('1');
      expect(call.env?.GIT_SENTINEL_X).toBeUndefined();
      expect(call.cwd).toBe(root);
    }
    // The real index is asked for with NO private index set -- `--git-path
    // index` honours GIT_INDEX_FILE -- and every later call uses one.
    const [lookup, ...rest] = calls;
    expect(lookup?.env?.GIT_INDEX_FILE).toBeUndefined();
    for (const call of rest) {
      expect(path.basename(call.env?.GIT_INDEX_FILE ?? '')).toBe('index');
    }
  });

  it('starts the private index from a copy of the real one', async () => {
    let isCopied = false;
    const exec: Exec = (command, args, options) => {
      if (args[0] === 'add') {
        isCopied = existsSync(options?.env?.GIT_INDEX_FILE ?? '');
      }
      return spawnExec(command, args, options);
    };

    expect(await treeFingerprint(exec, root, 'main')).toBeDefined();
    expect(isCopied).toBe(true);
  });

  it.each([
    ['a failing rev-parse', answered('.git/index', 1)],
    ['an empty rev-parse', answered('')],
  ])('gives up after %s', async (_label, revParse) => {
    const calls: Call[] = [];
    const exec = scripted({ ...HEALTHY, 'rev-parse': revParse }, calls);

    expect(await treeFingerprint(exec, root, 'main')).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['add fails', { add: answered('', 1) }],
    ['write-tree fails', { 'write-tree': answered('abc\n', 1) }],
    ['write-tree prints nothing', { 'write-tree': answered('\n') }],
  ])('is undefined when %s', async (_label, override) => {
    const exec = scripted({ ...HEALTHY, ...override }, []);
    expect(await treeFingerprint(exec, root, 'main')).toBeUndefined();
  });

  it('joins the tree, the merge-base and the package version', async () => {
    const calls: Call[] = [];
    const exec = scripted(HEALTHY, calls);

    expect(await treeFingerprint(exec, root, 'main')).toBe(
      `abc|basesha|${packageVersion()}`,
    );
    expect(calls.at(-1)?.args).toEqual(['merge-base', 'main', 'HEAD']);
  });

  it('removes its scratch directory', async () => {
    const calls: Call[] = [];
    await treeFingerprint(scripted(HEALTHY, calls), root, 'main');
    const scratch = path.dirname(calls[1]?.env?.GIT_INDEX_FILE ?? '');
    expect(existsSync(scratch)).toBe(false);
  });

  it('tolerates the scratch directory already being gone', async () => {
    const exec = scripted(HEALTHY, [], (call) => {
      if (call.args[0] === 'write-tree') {
        rmSync(path.dirname(call.env?.GIT_INDEX_FILE ?? ''), {
          recursive: true,
          force: true,
        });
      }
    });
    await expect(treeFingerprint(exec, root, 'main')).resolves.toBeDefined();
  });
});
