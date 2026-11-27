import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runCommitGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import type { StackConfig } from '../src/packs/pack.js';
import { readViolations, stateDirectory } from '../src/state-store.js';

/** Fixer names for the delegation pointer; these tests are about the auditor
 *  and the sanction budget, so the routing itself is exercised elsewhere. */
const config: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

/**
 * A real directory, because a blocking `runCommitGate` now writes the
 * violations manifest the commit-rung fixer is pointed at (#49) -- the same
 * side effect `runStopGate` has always had. These tests predate that and used
 * a `/repo` path that never existed on disk.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-commit-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function execResult(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

// An Exec that returns a merge-base sha, then a diff for `git diff <sha>`.
function fakeExec(diffForBase: string): Exec {
  return (command, args) => {
    if (args[0] === 'merge-base')
      return Promise.resolve(execResult('BASESHA\n'));
    if (args[0] === 'diff' && args[1] === 'BASESHA')
      return Promise.resolve(execResult(diffForBase));
    return Promise.resolve(execResult(''));
  };
}

const ADDED_DISABLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,1 @@',
  '+// eslint-disable-next-line',
].join('\n');

const SANCTIONED_DISABLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,1 @@',
  '+// Stryker disable all',
].join('\n');

const TWO_IDENTICAL_DISABLES = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +1,2 @@',
  '+// Stryker disable all',
  '+// Stryker disable all',
].join('\n');

describe('runCommitGate', () => {
  it('flags a suppression introduced on the branch (merge-base diff)', async () => {
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(ADDED_DISABLE),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('exempts a reviewed suppression listed in sanctionedSuppressions', async () => {
    // The branch introduces a deliberate, human-reviewed mutation exclusion.
    // Without the allowlist this re-flags on EVERY later commit (the commit
    // gate has no per-loop snapshot baseline), wedging the branch.
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(SANCTIONED_DISABLE),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('still flags the same directive in a file the allowlist does not cover', async () => {
    // The key is file-scoped, so a sanction on src/a.ts grants nothing to b.ts.
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(SANCTIONED_DISABLE.replaceAll('src/a.ts', 'src/b.ts')),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
        },
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('blocks a second identical directive once a count-1 grant is spent (headline defect)', async () => {
    // The defect this fix closes: `file|kind|text` carries no occurrence
    // identity, so a single sanction used to exempt EVERY occurrence of the
    // same directive in the file, however many an agent added. A count-1
    // grant must now exempt exactly one occurrence and block the second.
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
          count: 1,
        },
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it('exempts exactly as many occurrences as the granted count', async () => {
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'reviewed',
          count: 2,
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('sums counts across several entries sharing a key into one budget', async () => {
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(TWO_IDENTICAL_DISABLES),
      sanctionedSuppressions: [
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'first site',
          count: 1,
        },
        {
          key: 'src/a.ts|mutation-suppress|// Stryker disable all',
          reason: 'second site',
          count: 1,
        },
      ],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('is clean when the branch diff has no suppressions', async () => {
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec('+const x = 1;\n'),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('passes the configured analyzer policy through to verify', async () => {
    const commands: string[] = [];
    // Only the command name matters here, so the args parameter is omitted --
    // the house eslint config rejects an unused parameter.
    const exec: Exec = (command) => {
      commands.push(command);
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    };
    await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec,
      analyzers: { knip: 'off' },
    });
    expect(commands).not.toContain('knip');
  });
});

// Same CI-checkout shape as verify: the base branch may exist only as
// `origin/<branch>`. The merge-base must be taken against whichever form
// resolves, or the gate silently audits the wrong range.
function recordingExec(resolvable: readonly string[]): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'rev-parse') {
      const reference = args.at(-1) ?? '';
      return Promise.resolve(
        resolvable.some((candidate) => reference.startsWith(candidate))
          ? execResult('SHA\n')
          : { stdout: '', stderr: 'fatal: bad revision', code: 128 },
      );
    }
    if (args[0] === 'merge-base')
      return Promise.resolve(execResult('BASESHA\n'));
    return Promise.resolve(execResult(''));
  };
  return { exec, calls };
}

describe('commit gate base branch resolution', () => {
  it('takes the merge-base against origin/<branch> when only that resolves', async () => {
    const { exec, calls } = recordingExec(['origin/main']);
    await runCommitGate({ repoRoot: root, config, baseBranch: 'main', exec });
    expect(calls.find((call) => call[1] === 'merge-base')).toContain(
      'origin/main',
    );
  });

  it('falls back to the configured branch name when nothing resolves', async () => {
    // Paired with the case above: a fallback yielding `undefined` instead of
    // the branch name fails here rather than passing silently.
    const { exec, calls } = recordingExec([]);
    await runCommitGate({ repoRoot: root, config, baseBranch: 'main', exec });
    expect(calls.find((call) => call[1] === 'merge-base')).toEqual([
      'git',
      'merge-base',
      'main',
      'HEAD',
    ]);
  });
});

/**
 * Every tool this gate might spawn, recorded.
 */
function spawnRecorder(): { exec: Exec; commands: string[] } {
  const commands: string[] = [];
  const exec: Exec = (command, args) => {
    commands.push(path.basename(command));
    if (args[0] === 'merge-base') {
      return Promise.resolve(execResult('BASESHA\n'));
    }
    if (args[0] === 'diff' && args[1] === 'BASESHA') {
      return Promise.resolve(execResult(''));
    }
    if (args[0] === 'diff' || args[0] === 'ls-files') {
      return Promise.resolve(execResult('src/a.ts\n'));
    }
    return Promise.resolve(execResult(''));
  };
  return { exec, commands };
}

async function gateSpawns(
  profile: 'commit' | 'push' | 'ci' | undefined,
): Promise<string[]> {
  const { exec, commands } = spawnRecorder();
  await runCommitGate({
    repoRoot: root,
    baseBranch: 'main',
    exec,
    config,
    resolveBin: (tool) => tool,
    analyzers: { stryker: 'required' },
    analyzerRungs: { stryker: 'push' },
    ...(profile && { profile }),
  });
  return commands;
}

/**
 * The rung a gate invocation IS, which `gate --mode=push` and `--mode=ci` now
 * pass through (#61).
 *
 * Before this, `runCommitGate` hardcoded `profile: 'commit'` for all three
 * modes — they differed only in diff scope — so an analyzer a consumer moved
 * to `push` would have run at commit anyway, which is the whole thing the
 * config change is meant to prevent. The wiring is the part that regresses
 * silently: the override would parse, be forwarded, and never take effect.
 */
describe('the gate rung', () => {
  it('does not run a push-rung analyzer at the commit gate', async () => {
    expect(await gateSpawns('commit')).not.toContain('stryker');
  });

  it('runs it at the push gate', async () => {
    expect(await gateSpawns('push')).toContain('stryker');
  });

  it('runs it at the ci gate, which sits above push', async () => {
    expect(await gateSpawns('ci')).toContain('stryker');
  });

  it('defaults to the commit rung when no profile is given', async () => {
    // `.husky/pre-commit` calls `gate --mode=commit`, and every existing caller
    // that passes no profile must keep the cadence it had.
    expect(await gateSpawns(undefined)).not.toContain('stryker');
  });
});

/**
An added suppression in `file`, as the branch diff the gate audits.
*/
function addedDisableIn(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,0 +1,1 @@',
    '+// eslint-disable-next-line',
  ].join('\n');
}

const NO_ANALYZERS = {
  eslint: 'off',
  tsc: 'off',
  knip: 'off',
  'npm-peers': 'off',
  'dependency-cruiser': 'off',
  stryker: 'off',
} as const;

function writeWorkspace(): void {
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'] }),
  );
  mkdirSync(path.join(root, 'packages', 'billing'), { recursive: true });
  writeFileSync(path.join(root, 'packages', 'billing', 'package.json'), '{}');
}

describe('the manifest a blocked commit gate writes, across stacks', () => {
  it('names the package that owns an added suppression’s file', async () => {
    writeWorkspace();
    await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(addedDisableIn('packages/billing/src/a.ts')),
      analyzers: NO_ANALYZERS,
    });
    expect(
      readViolations(stateDirectory(root), 'nosession-commit').map(
        (violation) => [violation.file, violation.package],
      ),
    ).toEqual([['packages/billing/src/a.ts', 'packages/billing']]);
  });

  it('leaves a file unattributed when its stack has no pack in this version', async () => {
    writeWorkspace();
    const stacks: StackConfig[] = [
      {
        pack: 'typescript',
        root: '.',
        exclude: ['packages/billing/**'],
        wholeProjectTrigger: 'always',
        debugTargets: [],
      },
      {
        pack: 'swift',
        root: 'packages/billing',
        exclude: [],
        wholeProjectTrigger: 'stack-changes',
        debugTargets: [],
      },
    ];
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(addedDisableIn('packages/billing/src/a.ts')),
      analyzers: NO_ANALYZERS,
      stacks,
    });
    expect(result.blocked).toBe(true);
    const written = readViolations(stateDirectory(root), 'nosession-commit');
    expect(written.map((violation) => violation.ruleId)).toEqual([
      'guardrails/stack-unsupported',
      'guardrails/added-suppression',
    ]);
    // The file is owned by the Swift stack, which nobody can answer for.
    expect(written[1]).not.toHaveProperty('package');
    expect(written[1]).not.toHaveProperty('relatedTests');
  });
});

/**
A hunk of `file` that adds `lines` starting at line `start`.
*/
function swiftHunk(
  file: string,
  start: number,
  lines: readonly string[],
): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${String(start)},0 +${String(start)},${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

describe('the commit gate audits Swift', () => {
  const hooks = 'ios/Packages/Hooks/Sources/Hooks/Menu.swift';
  const swiftStack: StackConfig = {
    pack: 'swift',
    root: 'ios',
    exclude: [],
    wholeProjectTrigger: 'stack-changes',
    debugTargets: ['Hooks'],
  };

  async function kinds(
    diff: string,
    stacks?: readonly StackConfig[],
  ): Promise<string[]> {
    const result = await runCommitGate({
      repoRoot: root,
      config,
      baseBranch: 'main',
      exec: fakeExec(diff),
      analyzers: NO_ANALYZERS,
      stacks,
    });
    return result.findings.map((finding) => finding.kind);
  }

  it('reports a Swift escape added on the branch', async () => {
    expect(
      await kinds(
        swiftHunk('ios/App/Model.swift', 1, ['let data = try! load()']),
      ),
    ).toEqual(['force-try']);
  });

  it('exempts #if DEBUG under a Swift stack’s debug target', async () => {
    const diff = swiftHunk(hooks, 1, ['#if DEBUG']);
    expect(await kinds(diff)).toEqual(['compile-escape']);
    expect(await kinds(diff, [swiftStack])).toEqual([]);
  });

  it('reads the file to learn that a hunk begins inside a comment', async () => {
    const file = 'ios/App/Model.swift';
    const diff = swiftHunk(file, 2, [' let data = try! load()']);
    // Unreadable: the line is taken for code.
    expect(await kinds(diff)).toEqual(['force-try']);
    mkdirSync(path.join(root, 'ios', 'App'), { recursive: true });
    writeFileSync(path.join(root, file), '/*\n let data = try! load()\n */\n');
    expect(await kinds(diff)).toEqual([]);
  });
});
