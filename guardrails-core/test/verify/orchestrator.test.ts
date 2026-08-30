import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { runVerify } from '../../src/verify/index.js';

const eslintJson = JSON.stringify([
  {
    filePath: '/repo/src/foo.ts',
    messages: [
      {
        ruleId: 'no-console',
        severity: 2,
        message: 'Unexpected console statement.',
        line: 4,
        column: 3,
      },
    ],
  },
]);

const tscOut = "src/new.ts(2,1): error TS2304: Cannot find name 'oops'.";

const knipJson = JSON.stringify({
  issues: [
    {
      file: 'src/dead.ts',
      files: [{ name: 'src/dead.ts' }],
      exports: [],
      types: [],
      dependencies: [],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
  ],
});

const depcruiseJson = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/scope.ts',
        to: 'node:child_process',
        rule: { name: 'exec-seam', severity: 'error' },
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});

interface Call {
  command: string;
  args: string[];
  options: { cwd?: string } | undefined;
}

/** A fake exec that records calls and dispatches canned output by command. */
function fakeExec(overrides: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, options });
    const key = [command, ...args].join(' ');
    if (overrides[key]) {
      return Promise.resolve(overrides[key]);
    }
    if (args.includes('--name-only')) {
      return Promise.resolve(ok('src/foo.ts\nREADME.md'));
    }
    if (args.includes('--others')) {
      return Promise.resolve(ok('src/new.ts'));
    }
    if (command === 'eslint' || args.includes('eslint')) {
      return Promise.resolve(ok(eslintJson));
    }
    if (command === 'tsc' || args.includes('tsc')) {
      return Promise.resolve(ok(tscOut));
    }
    if (command === 'knip' || args.includes('knip')) {
      return Promise.resolve(ok(knipJson));
    }
    if (command === 'depcruise' || args.includes('depcruise')) {
      return Promise.resolve(ok(depcruiseJson));
    }
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

describe('runVerify', () => {
  it('aggregates eslint and tsc violations for changed TS files', async () => {
    const { exec } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    const ids = violations.map((v) => v.ruleId);
    expect(ids).toContain('no-console');
    expect(ids).toContain('TS2304');
    expect(violations.find((v) => v.tool === 'tsc')?.file).toBe('src/new.ts');
  });

  it('only lints TypeScript files (skips README.md)', async () => {
    const { exec, calls } = fakeExec();
    await runVerify({ repoRoot: '/repo', baseBranch: 'main', exec });
    const eslintCall = calls.find(
      (c) => c.command === 'eslint' || c.args.includes('eslint'),
    );
    expect(eslintCall?.args).toContain('src/foo.ts');
    expect(eslintCall?.args).toContain('src/new.ts');
    expect(eslintCall?.args).not.toContain('README.md');
  });

  it('short-circuits to clean when no TS files changed', async () => {
    const noTs = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md\ndocs/guide.md',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: noTs.exec,
    });
    expect(violations).toEqual([]);
    // Neither linter should have run.
    expect(
      noTs.calls.some((c) => c.command === 'eslint' || c.command === 'tsc'),
    ).toBe(false);
  });

  it('runs knip and includes its violations at the commit profile', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
    });
    expect(violations.map((v) => v.ruleId)).toContain('knip/files');
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(true);
  });

  it('does NOT run knip at the stop profile (default)', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec, // no profile → defaults to 'stop'
    });
    expect(violations.map((v) => v.ruleId)).not.toContain('knip/files');
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(false);
  });

  it('runs knip at the ci profile', async () => {
    const { exec, calls } = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'ci',
    });
    expect(
      calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(true);
  });

  it('still runs knip at the commit profile when zero TS files changed (whole-graph, not diff-scoped)', async () => {
    const noTs = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md\ndocs/guide.md',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: noTs.exec,
      profile: 'commit',
    });
    expect(
      noTs.calls.some((c) => c.command === 'knip' || c.args.includes('knip')),
    ).toBe(true);
    expect(violations.map((v) => v.ruleId)).toContain('knip/files');
    // eslint/tsc should still be skipped since there are no changed TS files.
    expect(
      noTs.calls.some((c) => c.command === 'eslint' || c.command === 'tsc'),
    ).toBe(false);
  });

  it('runs dependency-cruiser and includes its violations at the commit profile', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
    });
    expect(violations.map((v) => v.ruleId)).toContain(
      'dependency-cruiser/exec-seam',
    );
    expect(
      calls.some(
        (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
      ),
    ).toBe(true);
  });

  it('invokes dependency-cruiser layout-generically (no repo-specific target, no pinned config)', async () => {
    // Guards the consumer-repo value prop: guardrails-core ships into other
    // repos, so runDepcruise must not hardcode this monorepo's own layout.
    const { exec, calls } = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
    });
    const depcruiseCall = calls.find(
      (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
    );
    expect(depcruiseCall?.args).toEqual(['--output-type', 'json', '.']);
    // No repo-specific path, and DC auto-detects the consumer's own config
    // (mirroring runKnip) rather than pinning a filename via `--config`.
    expect(depcruiseCall?.args).not.toContain('guardrails-core/src');
    expect(depcruiseCall?.args).not.toContain('--config');
  });

  it('does NOT run dependency-cruiser at the stop profile', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    expect(violations.map((v) => v.ruleId)).not.toContain(
      'dependency-cruiser/exec-seam',
    );
    expect(
      calls.some(
        (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
      ),
    ).toBe(false);
  });

  it('runs dependency-cruiser at the commit profile even when zero TS files changed', async () => {
    const noTs = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: noTs.exec,
      profile: 'commit',
    });
    expect(
      noTs.calls.some(
        (c) => c.command === 'depcruise' || c.args.includes('depcruise'),
      ),
    ).toBe(true);
  });
});

describe('runVerify scope policy', () => {
  it('skips changed-files analyzers (eslint/tsc) when no .ts changed, runs whole-project (knip) at commit', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'README.md\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
    });
    const ran = (tool: string) =>
      calls.some((call) => call.command === tool || call.args.includes(tool));
    expect(ran('eslint')).toBe(false);
    expect(ran('tsc')).toBe(false);
    expect(ran('knip')).toBe(true); // whole-project runs even with no .ts changed
  });
});

describe('runStryker', () => {
  const strykerReport = JSON.stringify({
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: {
      'guardrails-core/src/foo.ts': {
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

  it('mutates changed production files, is consumer-generic, and maps survivors', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout:
          'guardrails-core/src/foo.ts\nguardrails-core/test/foo.test.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      resolveBin: (tool) => tool,
      readFile: () => Promise.resolve(strykerReport),
    });

    const strykerCall = calls.find((call) => call.command === 'stryker');
    expect(strykerCall).toBeDefined();
    const args = strykerCall?.args ?? [];
    // diff-scoped to the production file, test file excluded
    expect(args).toContain('--mutate');
    expect(args).toContain('guardrails-core/src/foo.ts');
    expect(args.join(' ')).not.toContain('foo.test.ts');
    // incremental + machine-readable json
    expect(args).toContain('--incremental');
    expect(args).toContain('--reporters');
    // consumer-generic: no config flag, no absolute/repo-specific path
    expect(args).not.toContain('--configFile');
    expect(args.every((argument) => !argument.startsWith('/'))).toBe(true);
    // survivor mapped
    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'stryker/survived',
        file: 'guardrails-core/src/foo.ts',
        line: 7,
      }),
    );
  });

  it('returns no stryker violations when only test files changed', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'guardrails-core/test/foo.test.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve('{}'),
    });
    expect(calls.some((call) => call.command === 'stryker')).toBe(false);
  });
});

describe('runVerify analyzer invocation contract', () => {
  it('runs every analyzer from repoRoot', async () => {
    // Kills the `{ cwd: repoRoot }` -> `{}` mutants. A dropped cwd would make
    // each tool resolve against the process cwd instead of the consumer repo —
    // the same class of consumer-genericity break the piece-2 review caught.
    const { exec, calls } = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve('{}'),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options?.cwd === '/repo')).toBe(true);
  });

  it('passes the documented argv to knip and tsc', async () => {
    // Kills the `[...]` -> `[]` argv mutants: an empty argv silently changes
    // knip's reporter (breaking the JSON adapter) and drops tsc's project flag.
    const { exec, calls } = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve('{}'),
    });
    const argvFor = (tool: string): string[] =>
      calls.find((call) => call.command === tool)?.args ?? [];
    expect(argvFor('knip')).toEqual(['--reporter', 'json']);
    expect(argvFor('tsc')).toEqual([
      '--noEmit',
      '--pretty',
      'false',
      '-p',
      'tsconfig.json',
    ]);
  });

  it('honours an explicit tsconfig and defaults when it is absent', async () => {
    // Kills the `options.tsconfig ?? 'tsconfig.json'` -> `&&` mutant.
    const custom = fakeExec();
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: custom.exec,
      tsconfig: 'packages/core/tsconfig.json',
    });
    expect(custom.calls.find((call) => call.command === 'tsc')?.args).toContain(
      'packages/core/tsconfig.json',
    );
  });

  it('returns no violations when stryker has nothing to mutate', async () => {
    // Kills the `return []` -> non-empty mutant on runStryker's early exit.
    const { exec } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'guardrails-core/test/foo.test.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve('{}'),
    });
    expect(violations.filter((v) => v.tool === 'stryker')).toEqual([]);
    // ...and every emitted violation is a real Violation, not a bare value: a
    // `tool`-filtered assertion alone silently drops non-objects.
    expect(violations.every((v) => Object.hasOwn(v, 'ruleId'))).toBe(true);
  });

  it('yields no stryker violations when the report cannot be read', async () => {
    // Kills the catch-block and `return []` mutants on the missing-report path:
    // a stryker crash must not fabricate or drop violations.
    const { exec } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'guardrails-core/src/foo.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.reject(new Error('ENOENT')),
    });
    expect(violations.filter((v) => v.tool === 'stryker')).toEqual([]);
    expect(violations.every((v) => Object.hasOwn(v, 'ruleId'))).toBe(true);
  });
});

describe('runVerify default readFile seam', () => {
  it('reads stryker’s report from disk when no readFile is injected', async () => {
    // Kills the default-arrow mutant on the `options.readFile ?? ...` fallback:
    // with `() => undefined` the real filesystem path is never exercised, and
    // every test above injects a reader, so nothing else covers it.
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'guardrails-stryker-'));
    await mkdir(path.join(repoRoot, 'reports', 'mutation'), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, 'reports', 'mutation', 'mutation.json'),
      JSON.stringify({
        files: {
          'src/foo.ts': {
            mutants: [
              {
                id: '1',
                mutatorName: 'ArithmeticOperator',
                status: 'Survived',
                location: { start: { line: 42, column: 1 } },
              },
            ],
          },
        },
      }),
      'utf8',
    );

    const { exec } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: 'src/foo.ts\n',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot,
      baseBranch: 'main',
      exec,
      profile: 'commit',
      // deliberately no readFile: exercise the node:fs/promises default
    });
    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'stryker/survived',
        file: 'src/foo.ts',
        line: 42,
      }),
    );
  });
});

/** An Exec where the named commands cannot be spawned at all. */
function execMissing(missing: readonly string[]): Exec {
  const { exec } = fakeExec();
  return (command, args, options) => {
    if (missing.some((name) => command.includes(name))) {
      return Promise.resolve({
        stdout: '',
        stderr: `spawn ${command} ENOENT`,
        code: 1,
        spawnFailed: true as const,
      });
    }
    return exec(command, args, options);
  };
}

describe('missing analyzers fail CLOSED', () => {
  it('reports every pack tool that could not be started', async () => {
    // Before this, a repo with none of the tools installed got an empty
    // violation list and a green gate: absence was indistinguishable from clean.
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: execMissing(['eslint', 'tsc', 'knip', 'depcruise', 'stryker']),
      profile: 'ci',
      readFile: () => Promise.resolve('{}'),
    });
    const missing = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-missing',
    );
    expect(missing.map((v) => v.message).join(' ')).toContain('eslint');
    expect(missing).toHaveLength(5);
    expect(missing.every((v) => v.severity === 'error' && !v.fixable)).toBe(
      true,
    );
  });

  it('flags only the missing tool and still runs the others', async () => {
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: execMissing(['knip']),
      profile: 'ci',
      readFile: () => Promise.resolve('{}'),
    });
    const missing = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-missing',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('knip');
    // ...and the analyzers that DID run still reported their findings.
    expect(violations.map((v) => v.ruleId)).toContain('no-console');
  });

  it('does not flag a tool that ran and exited non-zero with findings', async () => {
    // eslint exits 1 when it finds problems; tsc exits non-zero on type errors.
    // A non-zero code is the NORMAL case and must never read as absence.
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec().exec,
      profile: 'ci',
      readFile: () => Promise.resolve('{}'),
    });
    expect(
      violations.some((v) => v.ruleId === 'guardrails/analyzer-missing'),
    ).toBe(false);
    expect(violations.map((v) => v.ruleId)).toContain('no-console');
  });

  it('reports git itself when it cannot be started', async () => {
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: execMissing(['git']),
      profile: 'stop',
    });
    const missing = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-missing',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('git');
  });
});

describe('package attribution', () => {
  it('adds no package key in a single-package repo', async () => {
    // repoRoot '/repo' does not exist, so resolution degrades to undefined —
    // proving attribution cannot throw or fail a gate that would otherwise pass.
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: fakeExec().exec,
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => !Object.hasOwn(v, 'package'))).toBe(true);
  });
});
