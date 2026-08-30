import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { detect } from '../../src/scaffold/detect.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/** A fake git: toplevel, base branch, and core.hooksPath. */
function fakeExec(overrides: Record<string, ExecResult> = {}): Exec {
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (overrides[line]) {
      return Promise.resolve(overrides[line]);
    }
    if (line.includes('--show-toplevel')) return Promise.resolve(ok('/repo\n'));
    if (line.includes('core.hooksPath')) {
      return Promise.resolve({ stdout: '', stderr: '', code: 1 });
    }
    if (line.includes('symbolic-ref'))
      return Promise.resolve(ok('origin/main\n'));
    return Promise.resolve(ok(''));
  };
}

function facts(files: Record<string, unknown>, exec = fakeExec()) {
  return detect({
    exec,
    cwd: '/repo/packages/api',
    fileExists: (filePath) => Object.hasOwn(files, filePath),
    readJson: (filePath) => files[filePath],
  });
}

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

/** A fake git that also records exactly what it was called with, and where. */
function recordingFakeExec(overrides: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const behavior = fakeExec(overrides);
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    return behavior(command, args, options);
  };
  return { exec, calls };
}

describe('detect', () => {
  it('anchors at the git toplevel, not the working directory', async () => {
    const result = await facts({});
    expect(result.repoRoot).toBe('/repo');
  });

  it('reports which analyzer configs exist', async () => {
    const result = await facts({
      '/repo/tsconfig.json': {},
      '/repo/stryker.conf.json': {},
    });
    expect(result.hasTypeScriptConfig).toBe(true);
    expect(result.hasStrykerConfig).toBe(true);
    expect(result.hasDependencyCruiserConfig).toBe(false);
    expect(result.hasEslintConfig).toBe(false);
  });

  it('collects declared providers from package.json', async () => {
    const result = await facts({
      '/repo/package.json': { devDependencies: { eslint: '^9', knip: '^6' } },
    });
    expect(
      [...result.declaredProviders].sort((a, b) => a.localeCompare(b)),
    ).toEqual(['eslint', 'knip']);
  });

  it('reads an existing prepare script', async () => {
    const result = await facts({
      '/repo/package.json': { scripts: { prepare: 'husky' } },
    });
    expect(result.prepareScript).toBe('husky');
  });

  it('leaves prepareScript undefined when there is none', async () => {
    const result = await facts({ '/repo/package.json': {} });
    expect(result.prepareScript).toBeUndefined();
  });

  it('reports core.hooksPath when git has one configured', async () => {
    const exec = fakeExec({
      'git config --get core.hooksPath': ok('.githooks\n'),
    });
    const result = await facts({}, exec);
    expect(result.hooksPath).toBe('.githooks');
  });

  it('leaves hooksPath undefined when git has none', async () => {
    const result = await facts({});
    expect(result.hooksPath).toBeUndefined();
  });

  it('notices an existing guardrails.config.json', async () => {
    const result = await facts({ '/repo/guardrails.config.json': {} });
    expect(result.hasGuardrailsConfig).toBe(true);
  });

  it('parses an existing scaffold manifest', async () => {
    const result = await facts({
      '/repo/.guardrails/scaffold.json': {
        guardrailsVersion: '0.1.0',
        files: { 'x.md': 'sha256-a' },
      },
    });
    expect(result.manifest?.files).toEqual({ 'x.md': 'sha256-a' });
  });

  it('leaves the manifest undefined on an unscaffolded repo', async () => {
    const result = await facts({});
    expect(result.manifest).toBeUndefined();
  });

  it('derives the base branch from origin HEAD', async () => {
    const result = await facts({});
    expect(result.baseBranch).toBe('main');
  });

  it('falls back to main when origin HEAD is unknown', async () => {
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': {
        stdout: '',
        stderr: '',
        code: 1,
      },
    });
    const result = await facts({}, exec);
    expect(result.baseBranch).toBe('main');
  });

  it('recognizes any accepted eslint or dependency-cruiser config filename', async () => {
    // `anyExists` accepts several candidate filenames per analyzer -- only ONE
    // needs to exist. Exercising a single non-first candidate for each of two
    // different candidate lists proves it is "any of", not "all of" or "the
    // first one only".
    const eslintResult = await facts({ '/repo/eslint.config.cjs': {} });
    expect(eslintResult.hasEslintConfig).toBe(true);

    const dependencyCruiserResult = await facts({
      '/repo/.dependency-cruiser.json': {},
    });
    expect(dependencyCruiserResult.hasDependencyCruiserConfig).toBe(true);
  });

  it('runs each git command anchored at the resolved repo root, with the exact argv detect relies on', async () => {
    const { exec, calls } = recordingFakeExec();
    await facts({}, exec);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo/packages/api',
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
      },
      {
        command: 'git',
        args: ['config', '--get', 'core.hooksPath'],
        cwd: '/repo',
      },
    ]);
  });

  it('derives a base branch other than main from origin HEAD', async () => {
    // The default fake's `origin/main` collides with the fallback value, so a
    // mutant that always falls back to `main` can hide behind it. A branch
    // name that is NOT `main` proves the real value is actually being read.
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD':
        ok('origin/develop\n'),
    });
    const result = await facts({}, exec);
    expect(result.baseBranch).toBe('develop');
  });

  it('only strips a leading origin/, not one occurring elsewhere in the name', async () => {
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': ok(
        'quirky-origin/main\n',
      ),
    });
    const result = await facts({}, exec);
    expect(result.baseBranch).toBe('quirky-origin/main');
  });

  it('falls back to main on a non-zero exit even when stdout has stray content', async () => {
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': {
        stdout: 'origin/develop\n',
        stderr: 'error',
        code: 1,
      },
    });
    const result = await facts({}, exec);
    expect(result.baseBranch).toBe('main');
  });

  it('falls back to main when the branch lookup exits zero but prints nothing', async () => {
    const exec = fakeExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': ok(''),
    });
    const result = await facts({}, exec);
    expect(result.baseBranch).toBe('main');
  });

  it('leaves hooksPath undefined on a non-zero exit even when stdout has stray content', async () => {
    const exec = fakeExec({
      'git config --get core.hooksPath': {
        stdout: '.githooks\n',
        stderr: 'error',
        code: 1,
      },
    });
    const result = await facts({}, exec);
    expect(result.hooksPath).toBeUndefined();
  });

  it('leaves hooksPath undefined when git exits zero but prints nothing', async () => {
    const exec = fakeExec({
      'git config --get core.hooksPath': ok(''),
    });
    const result = await facts({}, exec);
    expect(result.hooksPath).toBeUndefined();
  });

  it('ignores a non-string prepare script value', async () => {
    const result = await facts({
      '/repo/package.json': { scripts: { prepare: 123 } },
    });
    expect(result.prepareScript).toBeUndefined();
  });

  it('falls back to the real filesystem and JSON reader when none are injected', async () => {
    // Proves the default `fileExists`/`readJson` seams (existsSync,
    // readJsonFile) are wired up, not just the injected fakes every other
    // test uses -- by writing a REAL package.json/tsconfig.json to a temp
    // directory and asserting their actual content is reflected, not merely
    // that the defaults tolerate a missing file.
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'guardrails-detect-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ devDependencies: { eslint: '^9' } }),
    );
    writeFileSync(path.join(repoRoot, 'tsconfig.json'), '{}');

    const exec = fakeExec({
      'git rev-parse --show-toplevel': ok(`${repoRoot}\n`),
    });
    const result = await detect({ exec, cwd: repoRoot });
    expect(result.hasTypeScriptConfig).toBe(true);
    expect([...result.declaredProviders]).toEqual(['eslint']);
  });
});
