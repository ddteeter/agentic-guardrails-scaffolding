import { existsSync } from 'node:fs';
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

describe('runVerify default readFile/removeFile seams', () => {
  const STRYKER_REPORT_PATH = path.join('reports', 'mutation', 'mutation.json');

  it('reads stryker’s report from disk, at its default location, when no readFile is injected', async () => {
    // Kills the default-arrow mutant on the `options.readFile ?? ...` fallback:
    // with `() => undefined` the real filesystem path is never exercised, and
    // every test above injects a reader, so nothing else covers it. There is no
    // per-run path any more (no CLI flag can set one) — the fake `stryker`
    // here writes to stryker's own fixed default location, proving the real
    // reader reads that same default path runStryker reads back.
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'guardrails-stryker-'));
    const { exec: base } = fakeExec({
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
    const exec: Exec = async (command, args, options) => {
      if (command === 'stryker') {
        const fullPath = path.join(repoRoot, STRYKER_REPORT_PATH);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(
          fullPath,
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
        return { stdout: '', stderr: '', code: 0 };
      }
      return base(command, args, options);
    };
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

  it('deletes a real stale report from disk when no removeFile is injected', async () => {
    // Proves the default `removeFile` (node:fs/promises rm) actually removes
    // the file, not just that some function was called — a stale report left
    // by a prior run must be gone before stryker is invoked, or a run that
    // writes nothing would silently read the old one as if it were fresh.
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'guardrails-stryker-'));
    const fullPath = path.join(repoRoot, STRYKER_REPORT_PATH);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify({ files: {} }), 'utf8');
    const { exec: base } = fakeExec({
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
    let reportPathExistedAtStrykerInvocation: boolean | undefined;
    const exec: Exec = async (command, args, options) => {
      if (command === 'stryker') {
        reportPathExistedAtStrykerInvocation = existsSync(fullPath);
        // Never writes a report: simulates the missing-report failure mode,
        // proving the stale file above cannot be mistaken for a fresh one.
        return { stdout: '', stderr: '', code: 0 };
      }
      return base(command, args, options);
    };
    const { violations } = await runVerify({
      repoRoot,
      baseBranch: 'main',
      exec,
      profile: 'commit',
      // deliberately no removeFile: exercise the node:fs/promises default
    });
    expect(reportPathExistedAtStrykerInvocation).toBe(false);
    expect(existsSync(fullPath)).toBe(false);
    expect(violations).toContainEqual(
      expect.objectContaining({ ruleId: 'guardrails/analyzer-failed' }),
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
    // A tool that could not be STARTED must be reported only as missing, never
    // ALSO as analyzer-failed (each analyzer's own spawnFailed short-circuit —
    // e.g. runStryker's `if (result.spawnFailed === true) return [];` — must
    // fire before any exit-code check runs).
    expect(
      violations.some((v) => v.ruleId === 'guardrails/analyzer-failed'),
    ).toBe(false);
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

  it('attributes a violation to its declared workspace member end to end', async () => {
    // The absence assertion above only proves attribution does no harm even
    // when it cannot resolve anything; it would still pass if the wiring were
    // deleted entirely. This proves the feature actually works: a real
    // workspace on disk, a finding on a file inside a declared member, and the
    // resulting violation carrying that member's `package`.
    const repoRoot = await mkdtemp(
      path.join(tmpdir(), 'guardrails-workspace-'),
    );
    await writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
      'utf8',
    );
    const memberDirectory = path.join(repoRoot, 'packages', 'api');
    await mkdir(memberDirectory, { recursive: true });
    await writeFile(path.join(memberDirectory, 'package.json'), '{}', 'utf8');
    const changedFile = 'packages/api/src/thing.ts';
    await mkdir(path.dirname(path.join(repoRoot, changedFile)), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, changedFile),
      'export const thing = 1;\n',
      'utf8',
    );

    const memberEslintJson = JSON.stringify([
      {
        filePath: path.join(repoRoot, changedFile),
        messages: [
          {
            ruleId: 'no-console',
            severity: 2,
            message: 'Unexpected console statement.',
            line: 1,
          },
        ],
      },
    ]);
    const { exec } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: `${changedFile}\n`,
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      [`eslint --format json --no-warn-ignored ${changedFile}`]: {
        stdout: memberEslintJson,
        stderr: '',
        code: 1,
      },
    });

    const { violations } = await runVerify({
      repoRoot,
      baseBranch: 'main',
      exec,
    });

    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'no-console',
        file: changedFile,
        package: 'packages/api',
      }),
    );
  });
});

describe('analyzers that run and then fail (defect 1: exit code ignored)', () => {
  interface GenericAnalyzer {
    tool: string;
    key: string;
    findingsStdout: string;
    findingRuleId: string;
    profile?: 'stop' | 'commit' | 'ci';
  }

  const GENERIC_ANALYZERS: GenericAnalyzer[] = [
    {
      tool: 'eslint',
      key: 'eslint --format json --no-warn-ignored src/foo.ts src/new.ts',
      findingsStdout: eslintJson,
      findingRuleId: 'no-console',
    },
    {
      tool: 'tsc',
      key: 'tsc --noEmit --pretty false -p tsconfig.json',
      findingsStdout: tscOut,
      findingRuleId: 'TS2304',
    },
    {
      tool: 'knip',
      key: 'knip --reporter json',
      findingsStdout: knipJson,
      findingRuleId: 'knip/files',
      profile: 'commit',
    },
    {
      tool: 'dependency-cruiser',
      key: 'depcruise --output-type json .',
      findingsStdout: depcruiseJson,
      findingRuleId: 'dependency-cruiser/exec-seam',
      profile: 'commit',
    },
  ];

  for (const analyzer of GENERIC_ANALYZERS) {
    it(`does NOT flag ${analyzer.tool} as analyzer-failed when it exits non-zero WITH parseable findings`, async () => {
      // eslint exits 1 on findings; tsc/knip/dependency-cruiser exit non-zero
      // on their own findings too. A non-zero code here is the NORMAL
      // findings case and must be indistinguishable from a zero exit.
      const { exec } = fakeExec({
        [analyzer.key]: {
          stdout: analyzer.findingsStdout,
          stderr: '',
          code: 1,
        },
      });
      const { violations } = await runVerify({
        repoRoot: '/repo',
        baseBranch: 'main',
        exec,
        profile: analyzer.profile ?? 'stop',
        readFile: () => Promise.resolve('{}'),
      });
      expect(
        violations.some((v) => v.ruleId === 'guardrails/analyzer-failed'),
      ).toBe(false);
      expect(violations.map((v) => v.ruleId)).toContain(analyzer.findingRuleId);
    });

    it(`flags ${analyzer.tool} as analyzer-failed when it exits non-zero with EMPTY output (crash/misconfiguration)`, async () => {
      // A broken config or a crash starts the tool (spawnFailed never fires)
      // but writes nothing parseable — the exact hole this defect closes.
      const { exec } = fakeExec({
        [analyzer.key]: {
          stdout: '',
          stderr: `fatal error in ${analyzer.tool}\nmore detail on line 2`,
          code: 2,
        },
      });
      const { violations } = await runVerify({
        repoRoot: '/repo',
        baseBranch: 'main',
        exec,
        profile: analyzer.profile ?? 'stop',
        readFile: () => Promise.resolve('{}'),
      });
      const failed = violations.filter(
        (v) => v.ruleId === 'guardrails/analyzer-failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.message).toContain(analyzer.tool);
      expect(failed[0]?.message).toContain('2');
      expect(failed[0]?.message).toContain(`fatal error in ${analyzer.tool}`);
      expect(failed[0]?.severity).toBe('error');
      expect(failed[0]?.fixable).toBe(false);
      expect(failed[0]?.tool).toBe('guardrails');
      // distinct from the missing-binary case
      expect(
        violations.some((v) => v.ruleId === 'guardrails/analyzer-missing'),
      ).toBe(false);
    });
  }

  it('omits the stderr detail entirely when stderr is empty/whitespace-only', async () => {
    const { exec } = fakeExec({
      'eslint --format json --no-warn-ignored src/foo.ts src/new.ts': {
        stdout: '',
        stderr: '   \n   \n',
        code: 2,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      readFile: () => Promise.resolve('{}'),
    });
    const failed = violations.find(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed).toBeDefined();
    expect(failed?.message).not.toContain('First line of stderr');
  });

  it('picks the first NON-BLANK line of stderr, trimmed, skipping leading blank lines', async () => {
    const { exec } = fakeExec({
      'eslint --format json --no-warn-ignored src/foo.ts src/new.ts': {
        stdout: '',
        stderr: '\n   \n   fatal: config file not found   \nsome other detail',
        code: 2,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      readFile: () => Promise.resolve('{}'),
    });
    const failed = violations.find(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed?.message).toContain(
      'First line of stderr: "fatal: config file not found"',
    );
    // Neither the blank lines nor the untrimmed padding leaked through.
    expect(failed?.message).not.toContain('   fatal:');
    expect(failed?.message).not.toContain('some other detail');
  });
});

describe('git exit code ignored (defect 2)', () => {
  it('flags analyzer-failed naming git — with its exit code and stderr — when the tracked-diff call exits non-zero with empty stdout (e.g. a missing/unfetched base branch)', async () => {
    const { exec, calls } = fakeExec({
      'git diff --name-only --diff-filter=ACM main': {
        stdout: '',
        stderr: "fatal: bad revision 'main'",
        code: 128,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'ci',
      readFile: () => Promise.resolve('{}'),
    });
    const failed = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed.some((v) => v.message.includes('git'))).toBe(true);
    expect(failed.some((v) => v.message.includes('128'))).toBe(true);
    expect(failed.some((v) => v.message.includes("bad revision 'main'"))).toBe(
      true,
    );
    // The gate must NOT read clean: the changed-files-scoped analyzers were
    // skipped as a result of the (correctly empty) file list, but the
    // analyzer-failed violation above means the run overall is not clean.
    expect(
      calls.some((call) => call.command === 'eslint' || call.command === 'tsc'),
    ).toBe(false);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('flags analyzer-failed naming git when only the untracked-files call exits non-zero', async () => {
    const { exec } = fakeExec({
      'git ls-files --others --exclude-standard': {
        stdout: '',
        stderr: 'fatal: not a git repository',
        code: 128,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    const failed = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed.some((v) => v.message.includes('git'))).toBe(true);
    expect(failed.some((v) => v.message.includes('128'))).toBe(true);
  });

  it('does not double-report when git could not be started at all (spawnFailed pre-empts the exit-code check)', async () => {
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: execMissing(['git']),
    });
    expect(
      violations.filter((v) => v.ruleId === 'guardrails/analyzer-failed'),
    ).toHaveLength(0);
    expect(
      violations.filter((v) => v.ruleId === 'guardrails/analyzer-missing'),
    ).toHaveLength(1);
  });
});

describe('stryker fails open twice (defect 3)', () => {
  const changedFilesOverrides: Record<string, ExecResult> = {
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
  };

  function execWithStryker(strykerResult: ExecResult): {
    exec: Exec;
    calls: Call[];
  } {
    const { exec: base, calls } = fakeExec(changedFilesOverrides);
    const exec: Exec = (command, args, options) => {
      if (command === 'stryker') {
        calls.push({ command, args, options });
        return Promise.resolve(strykerResult);
      }
      return base(command, args, options);
    };
    return { exec, calls };
  }

  it('flags analyzer-failed and does NOT read clean when stryker crashes (non-zero exit)', async () => {
    // This repo sets no `break` threshold, so stryker exits 0 even with
    // surviving mutants — a non-zero exit here can only mean a crash.
    const { exec } = execWithStryker({
      stdout: '',
      stderr: 'FATAL ERROR: Reached heap limit',
      code: 1,
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.reject(new Error('must not be called')),
    });
    const failed = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed.some((v) => v.message.includes('stryker'))).toBe(true);
    expect(failed.some((v) => v.message.includes('1'))).toBe(true);
    expect(failed.some((v) => v.message.includes('Reached heap limit'))).toBe(
      true,
    );
    expect(violations.some((v) => v.ruleId === 'stryker/survived')).toBe(false);
  });

  it('flags analyzer-failed and does NOT read clean when stryker exits 0 but its report file is missing', async () => {
    const { exec } = execWithStryker({ stdout: '', stderr: '', code: 0 });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.reject(new Error('ENOENT: no such file')),
    });
    const failed = violations.filter(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain('stryker');
    expect(failed[0]?.severity).toBe('error');
    expect(failed[0]?.fixable).toBe(false);
    expect(failed[0]?.tool).toBe('guardrails');
    expect(violations.some((v) => v.ruleId === 'stryker/survived')).toBe(false);
  });

  it('deletes the report before running stryker, and passes no path flag', async () => {
    // The redesign: `--jsonReporter.fileName` is a config-file-only key, never
    // registered as a CLI flag, so the report path cannot be relocated per run.
    // Staleness is closed by DELETING the default path first instead — nothing
    // there afterwards means nothing else could have written it in between.
    const order: string[] = [];
    const { exec } = execWithStryker({ stdout: '', stderr: '', code: 0 });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: (command, args, execOptions) => {
        if (command.includes('stryker')) {
          order.push('run');
        }
        return exec(command, args, execOptions);
      },
      profile: 'commit',
      readFile: () => Promise.resolve(JSON.stringify({ files: {} })),
      removeFile: (filePath) => {
        order.push(`remove:${filePath}`);
        return Promise.resolve();
      },
    });
    // Deleted BEFORE the run — ordering is the property, not merely that a
    // delete happened at some point.
    expect(order[0]).toMatch(/^remove:/);
    expect(order[0]).toContain('mutation.json');
    expect(order[1]).toBe('run');
    expect(violations.filter((v) => v.tool === 'stryker')).toEqual([]);
  });

  it('carries no report-path flag and no repo-specific path in its argv', async () => {
    const { exec, calls } = execWithStryker({
      stdout: '',
      stderr: '',
      code: 0,
    });
    await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      readFile: () => Promise.resolve(JSON.stringify({ files: {} })),
      removeFile: () => Promise.resolve(),
    });
    const args = calls.find((call) => call.command === 'stryker')?.args ?? [];
    // The flag does not exist in stryker's CLI; passing it made every run fail.
    expect(args).not.toContain('--jsonReporter.fileName');
    expect(args.every((argument) => !argument.startsWith('/'))).toBe(true);
  });
});
