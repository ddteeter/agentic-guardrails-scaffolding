import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { packageVersion } from '../src/package-root.js';
import {
  isRememberedPreflight,
  PREFLIGHT_FAILED_MARKER,
  preflightFailedCommand,
  preflightFailedLine,
  preflightKey,
  runPreflight,
  type PreflightOptions,
} from '../src/preflight.js';
import {
  loadPreflightPass,
  savePreflightPass,
  stateDirectory,
} from '../src/state-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-preflight-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

interface Call {
  line: string;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  input: string | undefined;
}

/**
 * A git and sh whose every answer is `answers[<command line prefix>]`, else a
 * success with no output. An array answers in turn. Records every call.
 */
function fakeExec(answers: Record<string, ExecResult | ExecResult[]>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({
      line,
      cwd: options?.cwd,
      env: options?.env,
      input: options?.input,
    });
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    const answer = key === undefined ? ok('') : answers[key];
    const result = Array.isArray(answer)
      ? (answer.shift() ?? ok(''))
      : (answer ?? ok(''));
    return Promise.resolve(result);
  };
  return { exec, calls };
}

/**
The git answers that make a fingerprint of `tree`.
*/
function fingerprinted(
  tree: string | string[] = 'tree1',
): Record<string, ExecResult | ExecResult[]> {
  return {
    'git rev-parse --git-path index': ok('.git/index\n'),
    'git write-tree': Array.isArray(tree)
      ? tree.map((each) => ok(`${each}\n`))
      : ok(`${tree}\n`),
    'git merge-base main HEAD': ok('base1\n'),
  };
}

const COMMANDS = ['npm run build', 'npm test'];

function hashOf(commands: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(commands)).digest('hex');
}

function keyFor(tree: string, commands: readonly string[] = COMMANDS): object {
  return {
    fingerprint: `${tree}|base1|${packageVersion()}`,
    base: 'main',
    commands: hashOf(commands),
    node: process.version,
  };
}

function options(
  exec: Exec,
  over: Partial<PreflightOptions> = {},
): PreflightOptions {
  return {
    exec,
    repoRoot: root,
    baseBranch: 'main',
    commands: COMMANDS,
    env: {},
    remember: true,
    ...over,
  };
}

function shLines(calls: readonly Call[]): string[] {
  return calls
    .filter((call) => call.line.startsWith('sh -c'))
    .map((call) => call.line);
}

function directory(): string {
  return stateDirectory(root);
}

describe('preflightKey (#243)', () => {
  it('keys the tree, the resolved base, the command list and Node', async () => {
    const { exec } = fakeExec(fingerprinted());
    expect(await preflightKey(options(exec))).toEqual(keyFor('tree1'));
  });

  it('keys the origin ref when the base exists only there', async () => {
    const { exec } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --git-path index': ok('.git/index\n'),
      'git write-tree': ok('tree1\n'),
      'git merge-base origin/main HEAD': ok('base1\n'),
    });
    expect(await preflightKey(options(exec))).toMatchObject({
      fingerprint: `tree1|base1|${packageVersion()}`,
      base: 'origin/main',
    });
  });

  it('is undefined when the tree cannot be fingerprinted', async () => {
    const { exec } = fakeExec({});
    expect(await preflightKey(options(exec))).toBeUndefined();
  });
});

describe('isRememberedPreflight (#243)', () => {
  const key = {
    fingerprint: 'F',
    base: 'main',
    commands: 'C',
    node: 'v1',
  };

  it('matches a record with every field the same', () => {
    expect(isRememberedPreflight(key, { ...key })).toBe(true);
  });

  it.each([
    ['fingerprint', { ...key, fingerprint: 'G' }],
    ['base', { ...key, base: 'origin/main' }],
    ['commands', { ...key, commands: 'D' }],
    ['node', { ...key, node: 'v2' }],
  ])('misses a record whose %s differs', (_field, remembered) => {
    expect(isRememberedPreflight(key, remembered)).toBe(false);
  });

  it('misses when either side is absent', () => {
    expect(isRememberedPreflight(undefined, key)).toBe(false);
    expect(isRememberedPreflight(key, undefined)).toBe(false);
  });
});

describe('runPreflight: running the commands (#243)', () => {
  it('runs each command through sh, in order, from the root, with stdin closed', async () => {
    const { exec, calls } = fakeExec(fingerprinted());
    const environment = { MARK: 'yes' };
    const run = await runPreflight(options(exec, { env: environment }));
    expect(run).toEqual({ verdict: 'passed' });
    const ran = calls.filter((call) => call.line.startsWith('sh -c'));
    expect(ran).toEqual([
      {
        line: 'sh -c npm run build',
        cwd: root,
        env: environment,
        input: '',
      },
      { line: 'sh -c npm test', cwd: root, env: environment, input: '' },
    ]);
  });

  it('runs nothing, and asks git nothing, for an empty list', async () => {
    const { exec, calls } = fakeExec(fingerprinted());
    expect(await runPreflight(options(exec, { commands: [] }))).toEqual({
      verdict: 'empty',
    });
    expect(calls).toEqual([]);
  });

  it('stops at the first command that exits non-zero', async () => {
    const result = { stdout: 'built\n', stderr: 'boom\n', code: 2 };
    const { exec, calls } = fakeExec({
      ...fingerprinted(),
      'sh -c npm run build': result,
    });
    expect(await runPreflight(options(exec))).toEqual({
      verdict: 'failed',
      command: 'npm run build',
      result,
    });
    expect(shLines(calls)).toEqual(['sh -c npm run build']);
  });

  it('reads a command ended by a signal as an error, never a pass', async () => {
    const result: ExecResult = {
      stdout: '',
      stderr: '',
      code: 0,
      signal: 'SIGTERM',
    };
    const { exec, calls } = fakeExec({
      ...fingerprinted(),
      'sh -c npm run build': result,
    });
    expect(await runPreflight(options(exec))).toEqual({
      verdict: 'error',
      command: 'npm run build',
      result,
      why: 'was ended by SIGTERM before it finished',
    });
    expect(shLines(calls)).toEqual(['sh -c npm run build']);
  });

  it('reads a command that could not start as an error', async () => {
    const result: ExecResult = {
      stdout: '',
      stderr: 'spawn sh ENOENT',
      code: 1,
      spawnFailed: true,
    };
    const { exec } = fakeExec({
      ...fingerprinted(),
      'sh -c npm test': result,
    });
    expect(await runPreflight(options(exec))).toEqual({
      verdict: 'error',
      command: 'npm test',
      result,
      why: 'could not be started',
    });
  });
});

describe('runPreflight: the pass record (#243)', () => {
  it('writes the record once every command passed', async () => {
    const { exec } = fakeExec(fingerprinted());
    await runPreflight(options(exec));
    expect(loadPreflightPass(directory())).toEqual(keyFor('tree1'));
  });

  it('skips every command when the record matches', async () => {
    savePreflightPass(directory(), {
      fingerprint: `tree1|base1|${packageVersion()}`,
      base: 'main',
      commands: hashOf(COMMANDS),
      node: process.version,
    });
    const { exec, calls } = fakeExec(fingerprinted());
    expect(await runPreflight(options(exec))).toEqual({
      verdict: 'remembered',
    });
    expect(shLines(calls)).toEqual([]);
  });

  it('runs the commands despite a match when not asked to remember', async () => {
    savePreflightPass(directory(), {
      fingerprint: `tree1|base1|${packageVersion()}`,
      base: 'main',
      commands: hashOf(COMMANDS),
      node: process.version,
    });
    const { exec, calls } = fakeExec(fingerprinted());
    expect(await runPreflight(options(exec, { remember: false }))).toEqual({
      verdict: 'passed',
    });
    expect(shLines(calls)).toHaveLength(2);
  });

  it.each([
    ['a different list', { commands: hashOf(['npm test']) }],
    ['a different tree', { fingerprint: `tree0|base1|${packageVersion()}` }],
    ['a different base', { base: 'origin/main' }],
    ['a different Node', { node: 'v0.0.1' }],
  ])('re-runs the commands for a record of %s', async (_label, over) => {
    savePreflightPass(directory(), {
      fingerprint: `tree1|base1|${packageVersion()}`,
      base: 'main',
      commands: hashOf(COMMANDS),
      node: process.version,
      ...over,
    });
    const { exec, calls } = fakeExec(fingerprinted());
    expect(await runPreflight(options(exec))).toEqual({ verdict: 'passed' });
    expect(shLines(calls)).toHaveLength(2);
    expect(loadPreflightPass(directory())).toEqual(keyFor('tree1'));
  });

  it('writes nothing when the tree changed while the commands ran', async () => {
    const { exec } = fakeExec(fingerprinted(['tree1', 'tree2']));
    expect(await runPreflight(options(exec))).toEqual({ verdict: 'passed' });
    expect(loadPreflightPass(directory())).toBeUndefined();
  });

  it('writes nothing when the tree after the run cannot be fingerprinted', async () => {
    const { exec } = fakeExec({
      ...fingerprinted(),
      'git rev-parse --git-path index': [ok('.git/index\n'), ok('')],
    });
    expect(await runPreflight(options(exec))).toEqual({ verdict: 'passed' });
    expect(loadPreflightPass(directory())).toBeUndefined();
  });

  it('writes nothing when a command failed', async () => {
    const { exec } = fakeExec({
      ...fingerprinted(),
      'sh -c npm test': { stdout: '', stderr: 'red', code: 1 },
    });
    await runPreflight(options(exec));
    expect(loadPreflightPass(directory())).toBeUndefined();
  });

  it('runs the commands and writes nothing when the tree has no fingerprint', async () => {
    const { exec, calls } = fakeExec({});
    expect(await runPreflight(options(exec))).toEqual({ verdict: 'passed' });
    expect(shLines(calls)).toHaveLength(2);
    expect(loadPreflightPass(directory())).toBeUndefined();
    // With no fingerprint before the run there is no key to confirm, so git
    // is not asked to fingerprint the tree a second time afterwards.
    expect(
      calls.filter((call) =>
        call.line.startsWith('git rev-parse --git-path index'),
      ),
    ).toHaveLength(1);
  });
});

describe('the preflight-failed line (#243)', () => {
  it('names the command after the marker', () => {
    expect(preflightFailedLine('npm test')).toBe(
      `${PREFLIGHT_FAILED_MARKER} "npm test" failed`,
    );
    expect(PREFLIGHT_FAILED_MARKER).toBe(
      'guardrails: push stopped — preflight',
    );
  });

  it('reads the command back, quotes and all', () => {
    const command = 'echo "a b" && npm test';
    expect(preflightFailedCommand(preflightFailedLine(command))).toBe(command);
  });

  it('reads nothing out of any other line', () => {
    expect(
      preflightFailedCommand('guardrails: push blocked — x'),
    ).toBeUndefined();
    expect(
      preflightFailedCommand(`  ${preflightFailedLine('npm test')}`),
    ).toBeUndefined();
  });
});
