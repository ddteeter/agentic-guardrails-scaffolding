import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnExec } from '../src/exec.js';

const node = process.execPath;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-exec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('spawnExec', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.stdout.write("hi")']);
    expect(result.stdout).toBe('hi');
    expect(result.code).toBe(0);
  });

  it('captures a non-zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('runs in the given cwd', async () => {
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(process.cwd())'],
      {
        cwd: root,
      },
    );
    // macOS symlinks /var → /private/var; compare basenames to avoid that.
    expect(path.basename(result.stdout)).toBe(path.basename(root));
  });

  it('applies a custom environment (and can drop inherited vars)', async () => {
    // The load-bearing case: a caller wanting an isolated git invocation must be
    // able to strip inherited GIT_* vars so a hook's GIT_DIR can't hijack it.
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(String(process.env.GIT_DIR))'],
      { env: { PATH: process.env.PATH } },
    );
    expect(result.stdout).toBe('undefined');
  });

  it('resolves (does not reject) when the command does not exist', async () => {
    const result = await spawnExec('definitely-not-a-real-binary-xyz', []);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('spawn failure is distinguishable from a failing run', () => {
  it('flags spawnFailed when the binary does not exist', async () => {
    // A missing analyzer must not look like a clean one. Exit code cannot carry
    // this: eslint exits 1 on findings and tsc exits non-zero on type errors, so
    // non-zero is the NORMAL case.
    const result = await spawnExec('guardrails-no-such-binary-xyz', [
      '--version',
    ]);
    expect(result.spawnFailed).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('does NOT flag spawnFailed for a process that ran and exited non-zero', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('does NOT flag spawnFailed for a successful run', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log("ok")',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.spawnFailed).toBeUndefined();
  });
});

describe('env replacement', () => {
  it('passes an explicit env through, replacing the inherited one', async () => {
    // Load-bearing: hooks run with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
    // exported into the environment, and a `git` spawned from inside a hook
    // would target the HOOK's repo regardless of cwd unless they are stripped.
    const result = await spawnExec(
      process.execPath,
      ['-e', 'console.log(process.env.GUARDRAILS_PROBE)'],
      { env: { GUARDRAILS_PROBE: 'replaced' } },
    );
    expect(result.stdout.trim()).toBe('replaced');
  });

  it('inherits the parent environment when no env is given', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log(process.env.PATH === undefined ? "stripped" : "inherited")',
    ]);
    expect(result.stdout.trim()).toBe('inherited');
  });
});

describe('stderr capture from a real process', () => {
  // The `child.stderr.on('data')` handler was previously exercised only via the
  // spawn-error path (a missing binary), which fills `stderr` from the `error`
  // event instead. `analyzerFailedViolation` quotes the first line of stderr as
  // its diagnostic, so a process that RUNS and writes to stderr is the case
  // that actually has to work.
  it('accumulates what a running process writes to stderr', async () => {
    const result = await spawnExec(node, [
      '-e',
      String.raw`process.stderr.write("first line\nsecond line"); process.exit(2)`,
    ]);
    expect(result.stderr).toBe('first line\nsecond line');
    expect(result.code).toBe(2);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('accumulates stderr across multiple chunks without interleaving stdout', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.stderr.write("a"); process.stdout.write("OUT"); process.stderr.write("b");',
    ]);
    expect(result.stderr).toBe('ab');
    expect(result.stdout).toBe('OUT');
  });
});
