/**
 * `runVerify` across stacks (GR-02, GR-03): which analyzers a change set
 * selects, in which order, on which files, and how each pack is asked the
 * questions that used to be answered for TypeScript alone.
 *
 * Every pack here is a recording stand-in injected through
 * `VerifyOptions.packs`, so nothing depends on a real tool. The goldens
 * (`parity.test.ts`) are what hold the real TypeScript pack still.
 */

import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../../src/exec.js';
import type {
  StackConfig,
  StackPack,
  StackPackId,
} from '../../src/packs/pack.js';
import type { Rung } from '../../src/verify/analyzer-policy.js';
import {
  type Analyzer,
  isAnalyzerSelected,
  runVerify,
  stackPacks,
  type VerifyOptions,
} from '../../src/verify/index.js';
import type { Violation } from '../../src/violation.js';

const ok: ExecResult = { stdout: '', stderr: '', code: 0 };

function nothing(): undefined {
  return;
}

function isNever(): boolean {
  return false;
}

function done(): Promise<void> {
  return Promise.resolve();
}

function noTests(): () => undefined {
  return nothing;
}

interface Run {
  tool: string;
  files: string[];
}

interface ToolSpec {
  tool: string;
  scope: Analyzer['scope'];
  minRung?: Rung;
  /**
  Spawn this command through the tracked exec, so a failure to start counts.
  */
  spawns?: string;
}

function recordingPack(
  id: StackPackId,
  extension: string,
  tools: readonly ToolSpec[],
  runs: Run[],
): StackPack<Analyzer> {
  return {
    id,
    isSourceFile: (file) => file.endsWith(extension),
    isTestFile: isNever,
    isConfigFile: (file) => file.endsWith(`${extension}.config`),
    analyzers: tools.map((spec) => ({
      tool: spec.tool,
      provider: `${spec.tool}-provider`,
      minRung: spec.minRung ?? 'stop',
      scope: spec.scope,
      run: async (options, _resolveBin, files) => {
        runs.push({ tool: spec.tool, files });
        if (spec.spawns !== undefined) {
          await options.exec(spec.spawns, [], { cwd: options.repoRoot });
        }
        return [
          {
            ruleId: `${spec.tool}/found`,
            file: files[0] ?? `${id}.root`,
            message: `${spec.tool} ran`,
            severity: 'warn' as const,
            fixable: false,
            tool: spec.tool,
          },
        ];
      },
    })),
    isProviderDeclared: (stack, provider, manifest) =>
      manifest.has(provider) || stack.debugTargets.includes(provider),
    installHint: (provider) => `install ${provider} for ${id}`,
    autofix: done,
    ownerOf: (context) => (file) => `${id}@${context.stack.root}:${file}`,
    coveringTests: noTests,
  };
}

function stack(over: Partial<StackConfig>): StackConfig {
  return {
    pack: 'typescript',
    root: '.',
    exclude: [],
    wholeProjectTrigger: 'always',
    debugTargets: [],
    ...over,
  };
}

const WEB = stack({ exclude: ['ios/**'] });
const IOS = stack({
  pack: 'swift',
  root: 'ios',
  wholeProjectTrigger: 'stack-changes',
});

const WEB_TOOLS: readonly ToolSpec[] = [
  { tool: 'web-lint', scope: 'changed-files' },
  { tool: 'web-graph', scope: 'whole-project', minRung: 'commit' },
];
const IOS_TOOLS: readonly ToolSpec[] = [
  { tool: 'ios-lint', scope: 'changed-files' },
  { tool: 'ios-graph', scope: 'whole-project', minRung: 'commit' },
];

function gitExec(
  staged: readonly string[],
  failing: readonly string[] = [],
): Exec {
  return (command, args) => {
    if (command === 'git' && args[0] === 'diff') {
      return Promise.resolve({ ...ok, stdout: `${staged.join('\n')}\n` });
    }
    if (failing.includes(command)) {
      return Promise.resolve({ ...ok, code: 1, spawnFailed: true as const });
    }
    return Promise.resolve(ok);
  };
}

interface Scenario {
  staged: readonly string[];
  profile?: Rung;
  stacks?: readonly StackConfig[];
  over?: Partial<VerifyOptions>;
  webTools?: readonly ToolSpec[];
  iosTools?: readonly ToolSpec[];
  failing?: readonly string[];
}

async function verify(
  scenario: Scenario,
): Promise<{ runs: Run[]; violations: Violation[]; skipped: string[] }> {
  const runs: Run[] = [];
  const result = await runVerify({
    repoRoot: '/repo',
    baseBranch: 'main',
    exec: gitExec(scenario.staged, scenario.failing),
    changedScope: 'staged',
    profile: scenario.profile ?? 'commit',
    readSource: nothing,
    declaredProviders: new Set<string>(),
    packs: [
      recordingPack('typescript', '.ts', scenario.webTools ?? WEB_TOOLS, runs),
      recordingPack('swift', '.swift', scenario.iosTools ?? IOS_TOOLS, runs),
    ],
    ...(scenario.stacks !== undefined && { stacks: scenario.stacks }),
    ...scenario.over,
  });
  return {
    runs,
    violations: result.violations,
    skipped: result.skippedAnalyzers.map(([tool]) => tool),
  };
}

function tools(runs: readonly Run[]): string[] {
  return runs.map((run) => run.tool);
}

describe('the pack registry', () => {
  it('holds the TypeScript pack, with the built-in analyzer table', () => {
    const packs = stackPacks();
    expect(packs.map((pack) => pack.id)).toEqual(['typescript']);
    expect(packs[0]?.analyzers.map((analyzer) => analyzer.tool)).toEqual([
      'eslint',
      'tsc',
      'knip',
      'npm-peers',
      'dependency-cruiser',
      'stryker',
      'dupes',
      'complexity',
    ]);
  });
});

describe('runVerify with no stacks configured', () => {
  it('runs the TypeScript pack over the whole repository, as it always has', async () => {
    const { runs } = await verify({
      staged: ['src/a.ts', 'ios/App/a.swift', 'README.md'],
    });
    expect(runs).toEqual([
      { tool: 'web-lint', files: ['src/a.ts'] },
      { tool: 'web-graph', files: ['src/a.ts'] },
    ]);
  });

  it('hands over the files the pack calls source or config, and no others', async () => {
    const { runs } = await verify({
      staged: ['a.ts.config', 'src/a.ts', 'notes.txt'],
    });
    expect(runs[0]).toEqual({
      tool: 'web-lint',
      files: ['a.ts.config', 'src/a.ts'],
    });
  });

  it('does not stamp a violation with its stack', async () => {
    const { violations } = await verify({ staged: ['src/a.ts'] });
    expect(violations.map((violation) => violation.stack)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('still runs whole-project analyzers when no source file changed', async () => {
    const { runs } = await verify({ staged: ['README.md'] });
    expect(tools(runs)).toEqual(['web-graph']);
  });
});

describe('runVerify with two stacks', () => {
  const stacks = [WEB, IOS];

  it('runs no second-stack analyzer on a web-only change', async () => {
    const { runs } = await verify({ staged: ['src/a.ts'], stacks });
    expect(runs).toEqual([
      { tool: 'web-lint', files: ['src/a.ts'] },
      { tool: 'web-graph', files: ['src/a.ts'] },
    ]);
  });

  it('runs no web changed-files analyzer on a second-stack-only change', async () => {
    const { runs } = await verify({ staged: ['ios/App/a.swift'], stacks });
    expect(runs).toEqual([
      // `always`: the web stack's whole-project analyzers run on any change.
      { tool: 'web-graph', files: [] },
      { tool: 'ios-lint', files: ['ios/App/a.swift'] },
      { tool: 'ios-graph', files: ['ios/App/a.swift'] },
    ]);
  });

  it('runs each stack over its own files, in the order the stacks are listed', async () => {
    const changed = ['ios/App/a.swift', 'src/a.ts'];
    const webFirst = await verify({ staged: changed, stacks });
    expect(tools(webFirst.runs)).toEqual([
      'web-lint',
      'web-graph',
      'ios-lint',
      'ios-graph',
    ]);
    expect(webFirst.runs[0]?.files).toEqual(['src/a.ts']);
    expect(webFirst.runs[2]?.files).toEqual(['ios/App/a.swift']);
    const iosFirst = await verify({ staged: changed, stacks: [IOS, WEB] });
    expect(tools(iosFirst.runs)).toEqual([
      'ios-lint',
      'ios-graph',
      'web-lint',
      'web-graph',
    ]);
  });

  it('gives a file under an excluded path to no web analyzer', async () => {
    const { runs } = await verify({
      staged: ['ios/Tools/build.ts'],
      stacks,
    });
    // A .ts file, but the web stack excludes ios/** and the Swift pack does
    // not call it source: nobody lints it. It is still a change under ios/.
    expect(runs).toEqual([
      { tool: 'web-graph', files: [] },
      { tool: 'ios-graph', files: [] },
    ]);
  });

  it('ignores a file no stack owns', async () => {
    const { runs } = await verify({ staged: ['src/a.ts'], stacks: [IOS] });
    expect(runs).toEqual([]);
  });

  it('stamps every violation with the stack that produced it', async () => {
    const { violations } = await verify({
      staged: ['ios/App/a.swift', 'src/a.ts'],
      stacks,
    });
    expect(
      violations.map((violation) => [violation.tool, violation.stack]),
    ).toEqual([
      ['web-lint', 'typescript'],
      ['web-graph', 'typescript'],
      ['ios-lint', 'swift'],
      ['ios-graph', 'swift'],
    ]);
  });

  it('stamps a TypeScript-only stacks block too: the key is what opts in', async () => {
    const { violations } = await verify({
      staged: ['src/a.ts'],
      stacks: [stack({})],
    });
    expect(violations.map((violation) => violation.stack)).toEqual([
      'typescript',
      'typescript',
    ]);
  });
});

describe('wholeProjectTrigger', () => {
  const stacks = [WEB, IOS];

  it('stack-changes: skips the whole-project analyzers when the stack owns no changed file', async () => {
    const { runs } = await verify({ staged: ['src/a.ts'], stacks });
    expect(tools(runs)).not.toContain('ios-graph');
  });

  it('stack-changes: runs them when the stack owns a changed file of any kind', async () => {
    const { runs } = await verify({ staged: ['ios/Package.resolved'], stacks });
    expect(runs).toEqual([
      { tool: 'web-graph', files: [] },
      { tool: 'ios-graph', files: [] },
    ]);
  });

  it('always: runs them on a change the stack does not own', async () => {
    const { runs } = await verify({
      staged: ['src/a.ts'],
      stacks: [WEB, { ...IOS, wholeProjectTrigger: 'always' }],
    });
    expect(tools(runs)).toEqual(['web-lint', 'web-graph', 'ios-graph']);
  });

  it('runs every whole-project analyzer at ci, whatever changed', async () => {
    const { runs } = await verify({
      staged: ['src/a.ts'],
      stacks,
      profile: 'ci',
    });
    expect(tools(runs)).toEqual(['web-lint', 'web-graph', 'ios-graph']);
  });

  it('does not run them at push either, without a change in the stack', async () => {
    const { runs } = await verify({
      staged: ['src/a.ts'],
      stacks,
      profile: 'push',
    });
    expect(tools(runs)).toEqual(['web-lint', 'web-graph']);
  });

  it('still holds a whole-project analyzer to its rung', async () => {
    const { runs } = await verify({
      staged: ['ios/App/a.swift'],
      stacks,
      profile: 'stop',
    });
    expect(tools(runs)).toEqual(['ios-lint']);
  });
});

describe('--stack', () => {
  const stacks = [WEB, IOS];
  const changed = ['ios/App/a.swift', 'src/a.ts'];

  it('selects only the stacks of the named pack', async () => {
    const web = await verify({
      staged: changed,
      stacks,
      over: { stack: 'typescript' },
    });
    expect(tools(web.runs)).toEqual(['web-lint', 'web-graph']);
    const ios = await verify({
      staged: changed,
      stacks,
      over: { stack: 'swift' },
    });
    expect(tools(ios.runs)).toEqual(['ios-lint', 'ios-graph']);
  });

  it('selects the implicit TypeScript stack when none is configured', async () => {
    const web = await verify({
      staged: changed,
      over: { stack: 'typescript' },
    });
    expect(tools(web.runs)).toEqual(['web-lint', 'web-graph']);
    expect(web.violations.map((violation) => violation.ruleId)).toEqual([
      'web-lint/found',
      'web-graph/found',
    ]);
  });

  it('fails a run whose --stack names a pack no stack uses', async () => {
    const ios = await verify({ staged: changed, over: { stack: 'swift' } });
    expect(ios.runs).toEqual([]);
    expect(ios.violations).toEqual([
      {
        ruleId: 'guardrails/stack-unmatched',
        file: 'guardrails.config.json',
        message:
          '--stack=swift selects no stack: no entry of "stacks" in ' +
          'guardrails.config.json has "pack": "swift", so no analyzer ran. ' +
          'Add the stack, or drop the flag. A run that checked nothing is a ' +
          'failed gate, not a clean one.',
        severity: 'error',
        fixable: false,
        tool: 'guardrails',
        package: 'typescript@.:guardrails.config.json',
      },
    ]);
  });

  it('reports only the selected stack’s silently skipped analyzers', async () => {
    const both = await verify({ staged: changed, stacks });
    expect(both.skipped).toEqual([
      'web-lint',
      'web-graph',
      'ios-lint',
      'ios-graph',
    ]);
    const ios = await verify({
      staged: changed,
      stacks,
      over: { stack: 'swift' },
    });
    expect(ios.skipped).toEqual(['ios-lint', 'ios-graph']);
  });
});

describe('a stack whose pack this version does not have', () => {
  it('is one error against the config file, and runs nothing of that stack', async () => {
    const runs: Run[] = [];
    const result = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: gitExec(['ios/App/a.swift']),
      changedScope: 'staged',
      profile: 'commit',
      readSource: nothing,
      declaredProviders: new Set<string>(),
      packs: [recordingPack('typescript', '.ts', WEB_TOOLS, runs)],
      stacks: [WEB, IOS],
    });
    // Said first, beside any other finding about the config file itself.
    expect(result.violations).toEqual([
      {
        ruleId: 'guardrails/stack-unsupported',
        file: 'guardrails.config.json',
        message:
          'the "swift" stack at "ios" is configured, but this version of ' +
          'guardrails-core has no swift pack, so none of its analyzers ran. ' +
          'The diff auditor still reads its files. Upgrade guardrails-core ' +
          'to a version that ships the pack, or remove the entry until ' +
          'then. A stack that ran nothing is a failed gate, not a clean one.',
        severity: 'error',
        fixable: false,
        tool: 'guardrails',
        package: 'typescript@.:guardrails.config.json',
      },
      {
        ruleId: 'web-graph/found',
        file: 'typescript.root',
        message: 'web-graph ran',
        severity: 'warn',
        fixable: false,
        tool: 'web-graph',
        stack: 'typescript',
        package: 'typescript@.:typescript.root',
      },
    ]);
    expect(runs).toEqual([{ tool: 'web-graph', files: [] }]);
  });

  it('is not reported when --stack selects another pack', async () => {
    const runs: Run[] = [];
    const result = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      exec: gitExec(['README.md']),
      changedScope: 'staged',
      profile: 'stop',
      readSource: nothing,
      declaredProviders: new Set<string>(),
      packs: [recordingPack('typescript', '.ts', WEB_TOOLS, runs)],
      stacks: [WEB, IOS],
      stack: 'typescript',
    });
    expect(result.violations).toEqual([]);
  });
});

describe('questions a pack is asked', () => {
  const stacks = [WEB, IOS];

  it('asks the pack whether a provider was declared', async () => {
    const iosTools: readonly ToolSpec[] = [
      { tool: 'ios-lint', scope: 'changed-files', spawns: 'swiftlint' },
    ];
    const undeclared = await verify({
      staged: ['ios/App/a.swift'],
      stacks,
      iosTools,
      failing: ['swiftlint'],
    });
    // auto + undeclared: the absence is an opt-out, so nothing is reported.
    expect(
      undeclared.violations.map((violation) => violation.ruleId),
    ).not.toContain('guardrails/analyzer-missing');
    const declared = await verify({
      staged: ['ios/App/a.swift'],
      stacks: [WEB, { ...IOS, debugTargets: ['ios-lint-provider'] }],
      iosTools,
      failing: ['swiftlint'],
    });
    expect(
      declared.violations.filter(
        (violation) => violation.ruleId === 'guardrails/analyzer-missing',
      ),
    ).toEqual([
      {
        ruleId: 'guardrails/analyzer-missing',
        file: 'package.json',
        message:
          'ios-lint could not be started — it is not installed in this ' +
          'repo, so its checks did NOT run. Install it: install ' +
          'ios-lint-provider for swift. A missing analyzer is a failed ' +
          'gate, not a clean one.',
        severity: 'error',
        fixable: false,
        tool: 'guardrails',
        stack: 'swift',
        package: 'typescript@.:package.json',
      },
    ]);
  });

  it('leaves a declared provider out of the silently skipped list', async () => {
    const { skipped } = await verify({
      staged: ['src/a.ts'],
      stacks: [WEB, { ...IOS, debugTargets: ['ios-lint-provider'] }],
    });
    expect(skipped).toEqual(['web-lint', 'web-graph', 'ios-graph']);
  });

  it('knows every pack’s analyzer names, so none reads as a typo', async () => {
    const { violations } = await verify({
      staged: ['README.md'],
      stacks,
      profile: 'stop',
      over: {
        analyzers: { 'ios-lint': 'off', 'web-graph': 'off', nonsense: 'off' },
      },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe('guardrails/analyzer-unknown');
    expect(violations[0]?.message).toContain('"nonsense"');
    expect(violations[0]?.message).toContain(
      'Known analyzers: web-lint, web-graph, ios-lint, ios-graph.',
    );
  });

  it('asks the owning stack’s pack who owns a violation’s file', async () => {
    const { violations } = await verify({
      staged: ['ios/App/a.swift', 'src/a.ts'],
      stacks,
      profile: 'stop',
    });
    expect(violations.map((violation) => violation.package)).toEqual([
      'typescript@.:src/a.ts',
      'swift@ios:ios/App/a.swift',
    ]);
  });
});

describe('an empty stacks list', () => {
  it('selects nothing and reports nothing: no stack was named and none missed', async () => {
    const { runs, violations } = await verify({
      staged: ['src/a.ts'],
      stacks: [],
    });
    expect(runs).toEqual([]);
    expect(violations).toEqual([]);
  });
});

function failingGit(): Promise<ExecResult> {
  return Promise.resolve({ ...ok, code: 128, stderr: 'fatal: bad' });
}

describe('a change set git could not answer for', () => {
  it('hands no file to any analyzer, even one that takes every file', async () => {
    const runs: Run[] = [];
    const result = await runVerify({
      repoRoot: '/repo',
      baseBranch: 'main',
      // The staged listing fails; no other call matters.
      exec: failingGit,
      changedScope: 'staged',
      profile: 'stop',
      readSource: nothing,
      declaredProviders: new Set<string>(),
      // An extension every path ends with: any file at all is "source".
      packs: [
        recordingPack(
          'typescript',
          '',
          [{ tool: 'web-lint', scope: 'changed-files' }],
          runs,
        ),
      ],
    });
    expect(runs).toEqual([]);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual([
      'guardrails/analyzer-failed',
    ]);
  });
});

describe('isAnalyzerSelected', () => {
  const selection = {
    analyzers: {},
    analyzerRungs: {},
    declared: new Set(['knip', 'eslint']),
    profile: 'commit' as const,
    hasChangedFiles: false,
  };

  it('counts a whole-project analyzer as selected with no changed file', () => {
    expect(isAnalyzerSelected('knip', selection)).toBe(true);
  });

  it('does not count a changed-files analyzer then', () => {
    expect(isAnalyzerSelected('eslint', selection)).toBe(false);
  });
});
