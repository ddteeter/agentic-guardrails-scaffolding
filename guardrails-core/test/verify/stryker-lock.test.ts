import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { LOCK_TIMEOUT_MARKER } from '../../src/ship.js';
import type { Rung } from '../../src/verify/analyzer-policy.js';
import { runVerify, type VerifyOptions } from '../../src/verify/index.js';
import type { Violation } from '../../src/violation.js';

let directory: string;
let lockPath: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'guardrails-stryker-lock-'));
  lockPath = path.join(directory, 'gate.lock');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

const report = JSON.stringify({
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/foo.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: {
            start: { line: 7, column: 1 },
            end: { line: 7, column: 4 },
          },
        },
      ],
    },
  },
});

/**
 * A repo whose only changed file is `src/foo.ts`, on a machine with `lockf`
 * whose lock is free or busy. Every analyzer but stryker is switched off by
 * the caller, so the calls left are git, the locker and stryker.
 */
function machine(lock: { busy: boolean; timesOut?: boolean }) {
  const strykerRuns: string[][] = [];
  const lockedEnvironments: (NodeJS.ProcessEnv | undefined)[] = [];
  const exec: Exec = (command, args, options) => {
    if (args.includes('--name-only')) return Promise.resolve(ok('src/foo.ts'));
    if (command === 'sh') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: args.at(-1)?.endsWith(' lockf') === true ? 0 : 1,
      });
    }
    if (command === 'lockf' && args.at(-1) === 'true') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: lock.busy ? 75 : 0,
      });
    }
    if (command === 'lockf') {
      if (lock.timesOut === true) {
        return Promise.resolve({ stdout: '', stderr: '', code: 75 });
      }
      strykerRuns.push(args.slice(6));
      lockedEnvironments.push(options?.env);
      return Promise.resolve(ok(''));
    }
    if (command === 'stryker') {
      strykerRuns.push(args);
      return Promise.resolve(ok(''));
    }
    return Promise.resolve(ok(''));
  };
  return { exec, strykerRuns, lockedEnvironments };
}

function verify(
  exec: Exec,
  profile: Rung,
  progress: string[] = [],
  analyzerRungs: Readonly<Record<string, Rung>> = {},
) {
  return runVerify({
    ...verifyOptions(exec, profile, analyzerRungs),
    progress: (line) => {
      progress.push(line);
    },
  });
}

function verifyOptions(
  exec: Exec,
  profile: Rung,
  analyzerRungs: Readonly<Record<string, Rung>> = {},
): VerifyOptions {
  return {
    analyzerRungs,
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    profile,
    resolveBin: (tool) => tool,
    readFile: (filePath) =>
      filePath.endsWith('.json')
        ? Promise.resolve(report)
        : Promise.reject(new Error('ENOENT')),
    declaredProviders: new Set(['@stryker-mutator/core']),
    analyzers: {
      eslint: 'off',
      tsc: 'off',
      knip: 'off',
      'dependency-cruiser': 'off',
      dupes: 'off',
      fallow: 'off',
      'npm-peers': 'off',
    },
    mutationLock: {
      path: lockPath,
      config: { commitWaitSeconds: 60, pushWaitSeconds: 10_800 },
    },
  };
}

function strykerViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter(
    (violation) =>
      violation.ruleId.startsWith('stryker/') ||
      violation.ruleId.startsWith('guardrails/mutation'),
  );
}

describe('runStryker under the mutation lock', () => {
  it('mutates under the lock and still maps survivors', async () => {
    const { exec, strykerRuns } = machine({ busy: false });
    const { violations } = await verify(exec, 'commit');
    expect(strykerRuns).toHaveLength(1);
    expect(strykerRuns[0]?.[0]).toBe('run');
    expect(strykerViolations(violations)).toEqual([
      expect.objectContaining({
        ruleId: 'stryker/survived',
        file: 'src/foo.ts',
      }),
    ]);
  });

  it('defers a commit whose wait ran out, without blocking, and says what next', async () => {
    const { exec, strykerRuns } = machine({ busy: true, timesOut: true });
    const { violations } = await verify(exec, 'commit');
    expect(strykerRuns).toEqual([]);
    const deferred = strykerViolations(violations);
    expect(deferred).toEqual([
      expect.objectContaining({
        ruleId: 'guardrails/mutation-deferred',
        file: 'src/foo.ts',
        severity: 'warn',
        fixable: false,
      }),
    ]);
    const message = deferred[0]?.message ?? '';
    expect(message).toContain(
      'the machine-wide mutation lock is busy (another checkout holds it)',
    );
    expect(message).toContain('will be mutation-tested at the push rung');
    expect(message).toContain('do not retry to force it');
    expect(message).toContain('do not wait for the lock');
  });

  it('defers the stop rung to commit without waiting', async () => {
    const { exec } = machine({ busy: true });
    const { violations } = await verify(exec, 'stop', [], { stryker: 'stop' });
    const message = strykerViolations(violations)
      .map((violation) => violation.message)
      .join('\n');
    expect(message).toContain('will be mutation-tested at the commit rung');
  });

  it('blocks a push whose wait ran out, in the words `ship` reads', async () => {
    const { exec } = machine({ busy: true, timesOut: true });
    const { violations } = await verify(exec, 'push');
    const timeout = strykerViolations(violations);
    expect(timeout).toEqual([
      expect.objectContaining({
        ruleId: 'guardrails/mutation-lock-timeout',
        severity: 'error',
        fixable: false,
        file: 'src/foo.ts',
      }),
    ]);
    const message = timeout[0]?.message ?? '';
    expect(message).toContain('after 10800s (another checkout holds it)');
    expect(message).toContain(LOCK_TIMEOUT_MARKER);
    expect(message).toContain('Re-run the push to re-queue');
    expect(message).toContain('never bypass it with --no-verify');
    expect(message).toContain(`rather than deleting ${lockPath}`);
  });

  it('prints the waiting line before a real wait', async () => {
    const { exec } = machine({ busy: true });
    const progress: string[] = [];
    await verify(exec, 'push', progress);
    expect(progress.join('\n')).toContain('waiting for the mutation lock');
  });

  it('prints the lock lines to stderr, one per line, when no progress sink is given', async () => {
    const { exec } = machine({ busy: true });
    const written: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await runVerify(verifyOptions(exec, 'push'));
    } finally {
      write.mockRestore();
    }
    const waiting = written.filter((text) =>
      text.includes('waiting for the mutation lock'),
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.endsWith('\n')).toBe(true);
  });

  it('runs the plain stryker args when no built progress plugin is found', async () => {
    const { exec, strykerRuns, lockedEnvironments } = machine({ busy: false });
    await verify(exec, 'commit');
    expect(strykerRuns).toEqual([
      ['run', '--incremental', '--reporters', 'json', '--mutate', 'src/foo.ts'],
    ]);
    expect(lockedEnvironments).toEqual([undefined]);
  });
});

describe('runStryker loads the progress plugin while it holds the lock', () => {
  it('adds the reporter and the plugin to the locked run', async () => {
    const { exec, strykerRuns } = machine({ busy: false });
    await runVerify({
      ...verifyOptions(exec, 'commit'),
      strykerProgressPlugin: '/pkg/dist/stryker-progress-plugin.mjs',
    });
    expect(strykerRuns).toEqual([
      [
        'run',
        '--incremental',
        '--reporters',
        'json,guardrails-progress',
        '--mutate',
        'src/foo.ts',
        '--appendPlugins',
        '/pkg/dist/stryker-progress-plugin.mjs',
      ],
    ]);
  });

  it('tells the plugin where the holder file is, on top of the inherited env', async () => {
    const { exec, lockedEnvironments } = machine({ busy: false });
    await runVerify({
      ...verifyOptions(exec, 'push'),
      strykerProgressPlugin: '/pkg/dist/stryker-progress-plugin.mjs',
    });
    expect(lockedEnvironments).toEqual([
      {
        ...process.env,
        GUARDRAILS_LOCK_HOLDER_FILE: `${lockPath}.holder.json`,
        GUARDRAILS_LOCK_RUNG: 'push',
        GUARDRAILS_LOCK_REPO: '/repo',
      },
    ]);
  });
});
