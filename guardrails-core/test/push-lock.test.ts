import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { packageVersion } from '../src/package-root.js';
import { pushLockDecision } from '../src/push-lock.js';
import { savePushPass, stateDirectory } from '../src/state-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-push-lock-'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@stryker-mutator/core': '*' } }),
  );
  writeFileSync(
    path.join(root, 'stryker.conf.json'),
    JSON.stringify({ mutate: ['src/**/*.ts'] }),
  );
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'feature.ts'), 'export {};\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/**
A git that reports `changed` as the branch diff over tree TREE1, base BASESHA.
*/
function gitReporting(changed: string): Exec {
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.includes('--git-path')) return Promise.resolve(ok('.git/index'));
    if (line.includes('write-tree')) return Promise.resolve(ok('TREE1\n'));
    if (line.includes('merge-base')) return Promise.resolve(ok('BASESHA\n'));
    if (line.includes('--name-only')) return Promise.resolve(ok(changed));
    return Promise.resolve(ok(''));
  };
}

/**
A git whose branch diff fails, as on an unfetched base.
*/
const gitFailingTheDiff: Exec = (command, args) =>
  args.includes('--name-only')
    ? Promise.resolve({ stdout: '', stderr: 'fatal: bad revision', code: 128 })
    : gitReporting('')(command, args);

/**
An exec that cannot start anything at all.
*/
const throwingExec: Exec = () => Promise.reject(new Error('boom'));

function decide(exec: Exec, extra: Record<string, unknown> = {}) {
  return pushLockDecision({
    repoRoot: root,
    baseBranch: 'main',
    exec,
    ...extra,
  });
}

describe('pushLockDecision', () => {
  it('needs the lock when a changed production file is in mutate scope', async () => {
    const decision = await decide(gitReporting('src/feature.ts'));
    expect(decision).toEqual({
      needed: true,
      reason: 'stryker will mutate 1 changed file',
    });
  });

  it('counts every changed file it will mutate', async () => {
    writeFileSync(path.join(root, 'src', 'other.ts'), 'export {};\n');
    const decision = await decide(gitReporting('src/feature.ts\nsrc/other.ts'));
    expect(decision.reason).toBe('stryker will mutate 2 changed files');
  });

  it('skips the lock when no changed file is in mutate scope', async () => {
    const decision = await decide(
      gitReporting('src/feature.test.ts\nREADME.md'),
    );
    expect(decision).toEqual({
      needed: false,
      reason: "no changed file is in stryker's mutate scope",
    });
  });

  it('skips the lock when the branch diff is empty', async () => {
    const decision = await decide(gitReporting(''));
    expect(decision).toEqual({
      needed: false,
      reason: 'stryker does not run for this push',
    });
  });

  it('skips the lock when the changed file is outside the declared mutate globs', async () => {
    mkdirSync(path.join(root, 'lib'));
    writeFileSync(path.join(root, 'lib', 'outside.ts'), 'export {};\n');
    const decision = await decide(gitReporting('lib/outside.ts'));
    expect(decision).toEqual({
      needed: false,
      reason: "no changed file is in stryker's mutate scope",
    });
  });

  it('skips the lock when the only changed file is an executable entry', async () => {
    writeFileSync(
      path.join(root, 'src', 'cli.ts'),
      '#!/usr/bin/env node\nexport {};\n',
    );
    const decision = await decide(gitReporting('src/cli.ts'));
    expect(decision).toEqual({
      needed: false,
      reason: "no changed file is in stryker's mutate scope",
    });
  });

  it('skips the lock when stryker does not run for this push', async () => {
    const decision = await decide(gitReporting('src/feature.ts'), {
      analyzers: { stryker: 'off' },
    });
    expect(decision).toEqual({
      needed: false,
      reason: 'stryker does not run for this push',
    });
  });

  it('skips the lock when stryker is moved to ci', async () => {
    const decision = await decide(gitReporting('src/feature.ts'), {
      analyzerRungs: { stryker: 'ci' },
    });
    expect(decision.needed).toBe(false);
  });

  it('skips the lock when this exact tree already passed', async () => {
    savePushPass(stateDirectory(root), {
      fingerprint: `TREE1|BASESHA|${packageVersion()}`,
      base: 'main',
    });
    const decision = await decide(gitReporting('src/feature.ts'));
    expect(decision).toEqual({
      needed: false,
      reason: 'this tree already passed the push gate',
    });
  });

  it('needs the lock when the branch diff cannot be read', async () => {
    const decision = await decide(gitFailingTheDiff);
    expect(decision).toEqual({
      needed: true,
      reason: 'the branch diff could not be read',
    });
  });

  it('needs the lock when deciding throws', async () => {
    const decision = await decide(throwingExec);
    expect(decision).toEqual({
      needed: true,
      reason: 'the probe failed: boom',
    });
  });
});
