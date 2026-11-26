/**
 * The CLI's side of stacks (GR-02, GR-03): `guardrails.config.json` `stacks`
 * reaching `verify`, the gates and `autofix`, the `--stack` flag, and the
 * warnings a dropped entry prints.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliDependencies, runCommand } from '../src/cli-core.js';
import type { ExecResult } from '../src/exec.js';

// See cli-core.test.ts: a hook's environment must not re-root these runs.
delete process.env.CLAUDE_PROJECT_DIR;

let root: string;
let errors: string[];
let spawned: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-cli-stacks-'));
  errors = [];
  spawned = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ enforcement: 'block', ...config }),
  );
}

/**
A repository whose change set is `changed`, recording every tool it spawns.
*/
function dependencies(changed: readonly string[], stdin = ''): CliDependencies {
  return {
    cwd: root,
    exec: (command, args) => {
      const line = [command, ...args].join(' ');
      if (command !== 'git') {
        spawned.push(path.basename(command));
        // An analyzer that ran and found nothing.
        return Promise.resolve(ok('[]'));
      }
      return Promise.resolve(
        ok(line.includes('--name-only') ? changed.join('\n') : ''),
      );
    },
    readStdin: () => Promise.resolve(stdin),
    selfPath: path.join(root, 'node_modules', 'guardrails-core', 'cli.mjs'),
    stdout: () => {
      // Nothing these commands print to stdout is under test.
    },
    stderr: (text) => {
      errors.push(text);
    },
    env: {},
  };
}

/**
The PostToolUse payload for an edit of `file`.
*/
function edit(file: string): string {
  return JSON.stringify({
    cwd: root,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, file) },
  });
}

const WEB_ONLY = {
  // ESLint alone: every other analyzer is off, so what was spawned is the
  // whole of what the stack selected.
  analyzers: {
    eslint: 'required',
    tsc: 'off',
    knip: 'off',
    'npm-peers': 'off',
    'dependency-cruiser': 'off',
    stryker: 'off',
  },
  stacks: [{ pack: 'typescript', root: '.', exclude: ['ios/**'] }],
};

describe('stacks reach the run from the config file', () => {
  it('verify: lints a file the TypeScript stack owns', async () => {
    writeConfig(WEB_ONLY);
    await runCommand('verify', [], dependencies(['src/a.ts']));
    expect(spawned).toContain('eslint');
  });

  it('verify: leaves a file the stack excludes alone', async () => {
    writeConfig(WEB_ONLY);
    await runCommand('verify', [], dependencies(['ios/Tools/a.ts']));
    expect(spawned).not.toContain('eslint');
  });

  it.each(['commit', 'push', 'ci'])(
    'gate --mode=%s: leaves a file the stack excludes alone',
    async (mode) => {
      writeConfig(WEB_ONLY);
      await runCommand(
        'gate',
        [`--mode=${mode}`],
        dependencies(['ios/Tools/a.ts']),
      );
      expect(spawned).not.toContain('eslint');
      await runCommand('gate', [`--mode=${mode}`], dependencies(['src/a.ts']));
      expect(spawned).toContain('eslint');
    },
  );

  it('gate --mode=stop: leaves a file the stack excludes alone', async () => {
    writeConfig(WEB_ONLY);
    const stdin = JSON.stringify({ session_id: 's', cwd: root });
    await runCommand(
      'gate',
      ['--mode=stop'],
      dependencies(['ios/Tools/a.ts'], stdin),
    );
    expect(spawned).not.toContain('eslint');
  });

  it('autofix: fixes a file its stack owns and no other', async () => {
    writeConfig(WEB_ONLY);
    await runCommand('autofix', [], dependencies([], edit('ios/Tools/a.ts')));
    expect(spawned).toEqual([]);
    await runCommand('autofix', [], dependencies([], edit('src/a.ts')));
    expect(spawned).toEqual(['eslint']);
  });
});

describe('--stack', () => {
  it('verify: fails when no configured stack uses the named pack', async () => {
    writeConfig({});
    expect(
      await runCommand('verify', ['--stack=swift'], dependencies(['src/a.ts'])),
    ).toBe(1);
    expect(errors.join('')).toContain('[guardrails/stack-unmatched]');
  });

  it('verify: runs only the named pack’s stacks', async () => {
    writeConfig({
      ...WEB_ONLY,
      stacks: [...WEB_ONLY.stacks, { pack: 'swift', root: 'ios' }],
    });
    const code = await runCommand(
      'verify',
      ['--stack=typescript'],
      dependencies(['src/a.ts']),
    );
    expect(errors.join('')).toBe('guardrails: clean (0 violations).\n');
    expect(code).toBe(0);
    expect(spawned).toContain('eslint');
    // The Swift stack has no pack in this version; unselected, it is not
    // reported either.
    expect(errors.join('')).not.toContain('stack-unsupported');
  });

  it('gate --mode=ci: passes the flag through', async () => {
    writeConfig({});
    expect(
      await runCommand(
        'gate',
        ['--mode=ci', '--stack=swift'],
        dependencies(['src/a.ts']),
      ),
    ).toBe(1);
    expect(errors.join('')).toContain('[guardrails/stack-unmatched]');
  });

  it.each([
    ['verify', ['--stack=java']],
    ['gate', ['--mode=ci', '--stack=java']],
  ])('%s: refuses a pack id it does not know', async (command, rest) => {
    writeConfig(WEB_ONLY);
    expect(await runCommand(command, rest, dependencies(['src/a.ts']))).toBe(2);
    expect(errors.join('')).toBe(
      'guardrails: --stack must be one of: typescript, swift.\n',
    );
    expect(spawned).toEqual([]);
  });

  it.each(['commit', 'push'])(
    'gate --mode=%s: refuses the flag, which only ci takes',
    async (mode) => {
      writeConfig(WEB_ONLY);
      expect(
        await runCommand(
          'gate',
          [`--mode=${mode}`, '--stack=typescript'],
          dependencies(['src/a.ts']),
        ),
      ).toBe(2);
      expect(errors.join('')).toBe(
        'guardrails: --stack applies to `verify` and `gate --mode=ci` only; ' +
          'the commit and push rungs gate every stack.\n',
      );
      expect(spawned).toEqual([]);
    },
  );
});

describe('a stacks entry that was dropped', () => {
  const broken = {
    analyzers: { eslint: 'off', tsc: 'off' },
    stacks: [{ pack: 'java', root: '.' }],
  };
  const lines =
    'guardrails: stacks entry 1 names no known pack (typescript, swift); ' +
    'ignored\n' +
    'guardrails: stacks holds no usable entry; the TypeScript default applies\n';

  it('verify says so', async () => {
    writeConfig(broken);
    await runCommand('verify', [], dependencies([]));
    expect(errors.join('')).toContain(lines);
  });

  it('the gate says so', async () => {
    writeConfig(broken);
    await runCommand('gate', ['--mode=ci'], dependencies([]));
    expect(errors.join('')).toContain(lines);
  });

  it('a clean config says nothing about stacks', async () => {
    writeConfig(WEB_ONLY);
    await runCommand('verify', [], dependencies([]));
    expect(errors.join('')).not.toContain('stacks');
  });
});
