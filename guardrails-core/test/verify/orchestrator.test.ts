import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import { ANALYZER_TOOLS, runVerify } from '../../src/verify/index.js';

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

const knipMissing = {
  'knip --reporter json': {
    stdout: '',
    stderr: '',
    code: 1,
    spawnFailed: true as const,
  },
};

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

  it('does not spawn an analyzer turned off in config', async () => {
    const { exec, calls } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      analyzers: { knip: 'off' },
      declaredProviders: new Set(['knip']),
    });
    expect(calls.some((call) => call.command === 'knip')).toBe(false);
    // A recognised key must never itself be flagged as unknown.
    expect(
      violations.some(
        (violation) => violation.ruleId === 'guardrails/analyzer-unknown',
      ),
    ).toBe(false);
  });

  it('lists exactly the analyzer table’s tool names', () => {
    expect(ANALYZER_TOOLS).toEqual([
      'eslint',
      'tsc',
      'knip',
      'dependency-cruiser',
      'stryker',
    ]);
  });

  it('reports a required analyzer that cannot start', async () => {
    const { exec } = fakeExec(knipMissing);
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      analyzers: { knip: 'required' },
      declaredProviders: new Set(),
    });
    expect(
      violations.filter(
        (violation) => violation.ruleId === 'guardrails/analyzer-missing',
      ),
    ).toHaveLength(1);
  });

  it('stays silent about an auto analyzer that is neither installed nor declared', async () => {
    const { exec } = fakeExec(knipMissing);
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      declaredProviders: new Set(),
    });
    expect(
      violations.some(
        (violation) => violation.ruleId === 'guardrails/analyzer-missing',
      ),
    ).toBe(false);
  });

  it('reports an auto analyzer that package.json declares but that cannot start', async () => {
    const { exec } = fakeExec(knipMissing);
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'commit',
      declaredProviders: new Set(['knip']),
    });
    const missing = violations.filter(
      (violation) => violation.ruleId === 'guardrails/analyzer-missing',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('knip');
  });

  it('warns about an unknown key in the analyzers block', async () => {
    const { exec } = fakeExec();
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      // Mixes a valid key alongside the typo so the filter's job — picking
      // out only the unrecognised one — is actually exercised.
      analyzers: { knip: 'off', knipp: 'off' },
      declaredProviders: new Set(),
    });
    const unknown = violations.filter(
      (violation) => violation.ruleId === 'guardrails/analyzer-unknown',
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe('warn');
    expect(unknown[0]?.fixable).toBe(false);
    expect(unknown[0]?.message).toContain('knipp');
    expect(unknown[0]?.message).toContain('has no effect');
    // A typo'd key leaves the REAL analyzer on `auto`, so it runs only if it is
    // installed. Claiming it "is still running" would be wrong in the common
    // case; what is always true is that the entry did nothing.
    expect(unknown[0]?.message).not.toContain('still running');
  });

  it('reads a real package.json from disk when declaredProviders is not injected', async () => {
    // Every test above injects declaredProviders directly; none exercises the
    // production default (`declaredProviders(readManifest(repoRoot))`) against
    // a manifest that actually parses. Without this, a knip devDependency
    // would never be discovered outside a test double.
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'guardrails-manifest-'));
    await writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ devDependencies: { knip: '^5.0.0' } }),
      'utf8',
    );
    const { exec } = fakeExec(knipMissing);
    const { violations } = await runVerify({
      repoRoot,
      baseBranch: 'main',
      exec,
      profile: 'commit',
      // deliberately no declaredProviders: exercise the real-fs default
    });
    const missing = violations.filter(
      (violation) => violation.ruleId === 'guardrails/analyzer-missing',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('knip');
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

  it('checks referenced projects for a solution-style tsconfig', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: JSON.stringify({
          files: [],
          references: [{ path: './tsconfig.app.json' }],
        }),
        stderr: '',
        code: 0,
      },
      'tsc --build --noEmit --pretty false tsconfig.json': {
        stdout: tscOut,
        stderr: '',
        code: 1,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    expect(calls.some((call) => call.args.includes('--build'))).toBe(true);
    expect(
      calls
        .filter(
          (call) =>
            call.args.includes('--showConfig') || call.args.includes('--build'),
        )
        .every((call) => call.options?.cwd === '/repo'),
    ).toBe(true);
    expect(violations.map((violation) => violation.ruleId)).toContain('TS2304');
    expect(
      violations.some(
        (violation) => violation.ruleId === 'guardrails/analyzer-failed',
      ),
    ).toBe(false);
  });

  it('fails closed when an apparently-clean tsc emits unreadable showConfig output', async () => {
    const { exec } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: 'not-json',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    expect(violations.map((violation) => violation.ruleId)).toContain(
      'guardrails/analyzer-failed',
    );
  });

  it.each(['null', '[]', '42', '"string"'])(
    'fails closed when showConfig returns the valid JSON value %s',
    async (stdout) => {
      const { exec, calls } = fakeExec({
        'tsc --noEmit --pretty false -p tsconfig.json': {
          stdout: '',
          stderr: '',
          code: 0,
        },
        'tsc --showConfig -p tsconfig.json': { stdout, stderr: '', code: 0 },
      });
      const { violations } = await runVerify({
        repoRoot: '/repo',
        baseBranch: 'main',
        exec,
      });
      expect(violations.map((violation) => violation.ruleId)).toContain(
        'guardrails/analyzer-failed',
      );
      expect(calls.some((call) => call.args.includes('--build'))).toBe(false);
    },
  );

  it('does not enter build mode when the resolved config has no references', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: '{"compilerOptions":{}}',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    expect(calls.some((call) => call.args.includes('--build'))).toBe(false);
    expect(violations.filter((violation) => violation.tool === 'tsc')).toEqual(
      [],
    );
  });

  it('fails closed when showConfig exits nonzero and never builds', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: '',
        stderr: 'bad config',
        code: 2,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      analyzers: {
        tsc: 'required',
        eslint: 'off',
        knip: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(violations).toEqual([
      expect.objectContaining({
        ruleId: 'guardrails/analyzer-failed',
        message: expect.stringContaining('code 2'),
      }),
    ]);
    expect(violations[0]?.message).toContain('bad config');
    expect(calls.some((call) => call.args.includes('--build'))).toBe(false);
  });

  it('does not build after showConfig cannot be spawned', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: '',
        stderr: 'spawn ENOENT',
        code: 0,
        spawnFailed: true,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      analyzers: {
        tsc: 'required',
        eslint: 'off',
        knip: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set(['guardrails/analyzer-failed', 'guardrails/analyzer-missing']),
    );
    expect(
      violations.find(
        (violation) => violation.ruleId === 'guardrails/analyzer-failed',
      )?.message,
    ).toContain('spawn ENOENT');
    expect(calls.some((call) => call.args.includes('--build'))).toBe(false);
  });

  it('does not inspect showConfig after the normal typecheck already failed', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: tscOut,
        stderr: '',
        code: 1,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
    });
    expect(violations.map((violation) => violation.ruleId)).toContain('TS2304');
    expect(calls.some((call) => call.args.includes('--showConfig'))).toBe(
      false,
    );
  });

  it('stops after the normal tsc executable cannot be spawned', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: 'spawn ENOENT',
        code: 0,
        spawnFailed: true,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      analyzers: {
        tsc: 'required',
        eslint: 'off',
        knip: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(violations).toEqual([
      expect.objectContaining({ ruleId: 'guardrails/analyzer-missing' }),
    ]);
    expect(calls.some((call) => call.args.includes('--showConfig'))).toBe(
      false,
    );
  });

  it('treats an empty references array as an ordinary non-solution config', async () => {
    const { exec, calls } = fakeExec({
      'tsc --noEmit --pretty false -p tsconfig.json': {
        stdout: '',
        stderr: '',
        code: 0,
      },
      'tsc --showConfig -p tsconfig.json': {
        stdout: '{"references":[]}',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      analyzers: {
        tsc: 'required',
        eslint: 'off',
        knip: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(violations).toEqual([]);
    expect(calls.some((call) => call.args.includes('--build'))).toBe(false);
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
      declaredProviders: new Set([
        'eslint',
        'typescript',
        'knip',
        'dependency-cruiser',
        '@stryker-mutator/core',
      ]),
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
      declaredProviders: new Set([
        'eslint',
        'typescript',
        'knip',
        'dependency-cruiser',
        '@stryker-mutator/core',
      ]),
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
    expect(failed?.message).not.toContain('stderr:');
  });

  it('keeps the non-blank stderr lines, trimmed, skipping blank ones', async () => {
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
      'stderr: "fatal: config file not found; some other detail"',
    );
    // Neither the blank lines nor the untrimmed padding leaked through.
    expect(failed?.message).not.toContain('   fatal:');
  });
});

/**
 * Verbatim eslint stderr for the single most likely first-adoption failure:
 * a repo with no flat config. The actionable sentence is on MEANINGFUL line
 * 3, behind a decorative banner and a version line -- so keeping only the
 * first line handed an unattended agent the word "Oops!" and nothing else.
 */
const eslintNoConfigStderr = [
  'Oops! Something went wrong! :(',
  '',
  'ESLint: 9.39.5',
  '',
  "ESLint couldn't find an eslint.config.* file.",
  '',
  'From ESLint v9.0.0, the default configuration file is now eslint.config.*.',
].join('\n');

async function failedMessage(stderr: string): Promise<string> {
  const { exec } = fakeExec({
    'eslint --format json --no-warn-ignored src/foo.ts src/new.ts': {
      stdout: '',
      stderr,
      code: 2,
    },
  });
  const { violations } = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec,
    readFile: () => Promise.resolve('{}'),
  });
  return (
    violations.find((v) => v.ruleId === 'guardrails/analyzer-failed')
      ?.message ?? ''
  );
}

describe('analyzer-failed stderr detail', () => {
  it('surfaces the diagnosis, not just the banner', async () => {
    const message = await failedMessage(eslintNoConfigStderr);
    expect(message).toContain("couldn't find an eslint.config.* file");
    // The banner is kept rather than pattern-matched away -- recognising each
    // tool's decorative first line is hardcoded third-party copy that rots on
    // upgrade. Five lines gets past every banner without knowing any of them.
    expect(message).toContain('Oops!');
  });

  it('caps runaway stderr at five meaningful lines', async () => {
    const message = await failedMessage(
      Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n'),
    );
    expect(message).toContain('line 4');
    expect(message).not.toContain('line 5');
  });

  it('truncates a single enormous line rather than flooding the manifest', async () => {
    const message = await failedMessage('x'.repeat(5000));
    expect(message.length).toBeLessThan(1000);
    expect(message).toContain('…');
  });

  it('keeps stderr that is exactly at the cap, untruncated', async () => {
    // The boundary. The two cases above sit far either side of 500, so they
    // cannot tell `<=` from `<` -- the difference shows up only at exactly the
    // limit, where a length-500 detail must survive whole rather than lose its
    // last character to an ellipsis.
    const exact = 'x'.repeat(500);
    const message = await failedMessage(exact);
    expect(message).toContain(exact);
    expect(message).not.toContain('…');
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

  it('deletes the report and incremental cache before running stryker', async () => {
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
    expect(order.slice(0, 2)).toEqual([
      expect.stringContaining('mutation.json'),
      expect.stringContaining('stryker-incremental.json'),
    ]);
    expect(order[2]).toBe('run');
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

describe('base branch resolution (the CI checkout case)', () => {
  // GitHub Actions checks a PR out as a detached merge ref and never creates
  // the base branch locally, so `git diff main` fails while `origin/main`
  // resolves. This was silently fail-open: no changed files meant every
  // diff-scoped analyzer was skipped and the run read clean.
  it('diffs against origin/<branch> when the local branch does not exist', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet origin/main^{commit}': {
        stdout: 'abc123',
        stderr: '',
        code: 0,
      },
      'git diff --name-only --diff-filter=ACM origin/main': {
        stdout: 'src/changed.ts',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'stop',
    });
    // The diff ran against the remote-qualified ref...
    expect(
      calls.some(
        (call) =>
          call.args.includes('origin/main') &&
          call.args.includes('--name-only'),
      ),
    ).toBe(true);
    // ...and the analyzers actually ran, rather than being skipped for want of
    // a changed-file list.
    expect(calls.some((call) => call.command.includes('eslint'))).toBe(true);
    expect(
      violations.some((v) => v.ruleId === 'guardrails/analyzer-failed'),
    ).toBe(false);
  });

  it('fails closed when neither the local nor the origin ref resolves', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet origin/main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'ci',
      readFile: () => Promise.resolve('{}'),
    });
    const failed = violations.find(
      (v) => v.ruleId === 'guardrails/analyzer-failed',
    );
    expect(failed?.message).toContain('base branch "main"');
    expect(failed?.message).toContain('SKIPPED');
    // An unresolvable base is a judgment call for a human (wrong config, or a
    // clone too shallow), never something an autofixer should touch.
    expect(failed?.fixable).toBe(false);
    expect(failed?.severity).toBe('error');
    // Paired with the positive case above: no diff was attempted, and the
    // changed-file-scoped analyzers did not run.
    expect(calls.some((call) => call.args.includes('--name-only'))).toBe(false);
    expect(calls.some((call) => call.command.includes('eslint'))).toBe(false);
  });

  it('checks every indexed and untracked TypeScript file on an unborn branch', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet origin/main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet HEAD': {
        stdout: '',
        stderr: 'fatal: Needed a single revision',
        code: 1,
      },
      'git ls-files': {
        stdout: 'src/index.ts\nREADME.md',
        stderr: '',
        code: 0,
      },
      'git ls-files --others --exclude-standard': {
        stdout: 'src/new.ts',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'stop',
    });
    const eslintCall = calls.find((call) => call.command === 'eslint');
    expect(eslintCall?.args).toContain('src/index.ts');
    expect(eslintCall?.args).toContain('src/new.ts');
    expect(
      calls.find(
        (call) =>
          call.command === 'git' &&
          call.args.length === 1 &&
          call.args[0] === 'ls-files',
      )?.options?.cwd,
    ).toBe('/repo');
    expect(
      violations.some((violation) =>
        violation.message.includes('base branch "main"'),
      ),
    ).toBe(false);
  });

  it('stops changed-file discovery when the base git process cannot spawn', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: 'spawn ENOENT',
        code: 1,
        spawnFailed: true,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'stop',
    });
    expect(violations).toEqual([
      expect.objectContaining({ ruleId: 'guardrails/analyzer-missing' }),
    ]);
    expect(calls.some((call) => call.args.includes('HEAD'))).toBe(false);
    expect(calls.some((call) => call.args.includes('ls-files'))).toBe(false);
  });

  it('stops changed-file discovery when the HEAD probe cannot spawn', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet origin/main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet HEAD': {
        stdout: '',
        stderr: 'spawn ENOENT',
        code: 1,
        spawnFailed: true,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'stop',
    });
    expect(violations).toEqual([
      expect.objectContaining({ ruleId: 'guardrails/analyzer-missing' }),
    ]);
    expect(calls.some((call) => call.args.includes('ls-files'))).toBe(false);
    expect(calls.find((call) => call.args.includes('HEAD'))?.options?.cwd).toBe(
      '/repo',
    );
  });

  it('fails closed when HEAD exists but the configured base cannot resolve', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse --verify --quiet main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet origin/main^{commit}': {
        stdout: '',
        stderr: '',
        code: 1,
      },
      'git rev-parse --verify --quiet HEAD': {
        stdout: 'abc123',
        stderr: '',
        code: 0,
      },
    });
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec,
      profile: 'stop',
    });
    expect(violations).toEqual([
      expect.objectContaining({
        ruleId: 'guardrails/analyzer-failed',
        message: expect.stringContaining('base branch "main"'),
      }),
    ]);
    expect(
      calls.some(
        (call) => call.command === 'git' && call.args.includes('ls-files'),
      ),
    ).toBe(false);
  });
});

/** knip walking into a nested worktree: a second checkout of this repository
 *  reported as dead code in THIS one, alongside one genuine finding. */
const knipWithWorktreeJson = JSON.stringify({
  issues: [
    { file: '.claude/worktrees/wt/src/dead.ts', files: [{ name: 'dead' }] },
    { file: 'src/really-dead.ts', files: [{ name: 'really-dead' }] },
  ],
});

function worktreeAwareExec(worktreeStdout: string): Exec {
  return fakeExec({
    'git worktree list --porcelain': {
      stdout: worktreeStdout,
      stderr: '',
      code: 0,
    },
    'knip --reporter json': {
      stdout: knipWithWorktreeJson,
      stderr: '',
      code: 1,
    },
  }).exec;
}

describe('runVerify nested-worktree filtering', () => {
  it('drops violations inside a nested worktree and keeps the rest', async () => {
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: worktreeAwareExec(
        'worktree /repo\n\nworktree /repo/.claude/worktrees/wt\n',
      ),
      profile: 'commit',
      analyzers: {
        knip: 'required',
        eslint: 'off',
        tsc: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(violations.map((violation) => violation.file)).toEqual([
      'src/really-dead.ts',
    ]);
  });

  it('keeps every violation when there is no nested worktree', async () => {
    // The positive control. Without it, an implementation that dropped
    // everything under '.claude/' unconditionally would also pass above.
    const { violations } = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: worktreeAwareExec('worktree /repo\n'),
      profile: 'commit',
      analyzers: {
        knip: 'required',
        eslint: 'off',
        tsc: 'off',
        'dependency-cruiser': 'off',
        stryker: 'off',
      },
    });
    expect(violations.map((violation) => violation.file)).toEqual([
      '.claude/worktrees/wt/src/dead.ts',
      'src/really-dead.ts',
    ]);
  });
});
