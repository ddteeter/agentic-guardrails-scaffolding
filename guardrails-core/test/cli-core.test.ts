import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliDeps, runCommand } from '../src/cli-core.js';
import type { ExecResult } from '../src/exec.js';
import { stateDirectory, writeViolations } from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let out: string[];
let errors: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-cli-'));
  out = [];
  errors = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: root,
    exec: () => Promise.resolve(ok('')),
    readStdin: () => Promise.resolve(''),
    stdout: (text) => out.push(text),
    stderr: (text) => errors.push(text),
    ...over,
  };
}

function violation(file: string): Violation {
  return {
    ruleId: 'no-console',
    file,
    message: 'Unexpected console.',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

describe('runCommand — verify', () => {
  it('returns 0 when no TypeScript files changed', async () => {
    expect(await runCommand('verify', [], deps())).toBe(0);
  });

  it('returns 1 and reports violations when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    expect(await runCommand('verify', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('no-console');
  });
});

describe('runCommand — audit', () => {
  it('returns 1 when the working diff adds a suppression', async () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+  // eslint-disable-next-line',
    ].join('\n');
    const exec = () => Promise.resolve(ok(diff));
    expect(await runCommand('audit', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('eslint-disable');
  });
});

describe('runCommand — state', () => {
  it('prints the current session and recurrence as JSON', async () => {
    expect(await runCommand('state', [], deps())).toBe(0);
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({
      session: { attempts: 0, ruleCounts: {}, corrected: [] },
      recurrence: {},
    });
  });
});

describe('runCommand — scope-check', () => {
  it('denies an edit to a file outside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/forbidden.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('stays silent for a file inside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/allowed.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });
});

describe('runCommand — gate stop', () => {
  it('emits a block decision when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('HEAD')) return Promise.resolve(ok(''));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({ decision: 'block' });
  });
});

describe('runCommand — session lifecycle', () => {
  it('session-start sweeps and returns 0', async () => {
    expect(await runCommand('session-start', [], deps())).toBe(0);
  });

  it('session-end returns 0', async () => {
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve(stdin) }),
      ),
    ).toBe(0);
  });
});

describe('runCommand — unknown', () => {
  it('prints usage and returns 1', async () => {
    expect(await runCommand('bogus', [], deps())).toBe(1);
    expect(errors.join('')).toContain('usage:');
  });
});
